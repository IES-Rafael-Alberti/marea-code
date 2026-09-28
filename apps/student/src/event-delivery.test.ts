import { expect, it } from "vitest";
import {
  AppendRunEventsRequestSchema,
  MAX_RUN_EVENTS_REQUEST_BYTES,
  type AppendRunEventsRequest,
} from "@marea/protocol";
import { boundedEventDelivery } from "./event-delivery.js";

function request(content: string, count: number): AppendRunEventsRequest {
  return AppendRunEventsRequestSchema.parse({
    kind: "run-events-append",
    protocolVersion: "0.1",
    requestId: "request:delivery",
    events: Array.from({ length: count }, (_, index) => ({
      eventType: "tool-finished",
      eventId: `event:delivery:${String(index)}`,
      sequence: index + 1,
      occurredAt: "2026-09-04T10:00:00.000Z",
      messageId: "message:delivery",
      callId: `call:${String(index)}`,
      failed: false,
      result: content,
      truncated: false,
    })),
  });
}
const size = (value: object) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
it("preserves small requests and rejects an envelope with no deliverable event", () => {
  const small = request("text", 1);
  expect(boundedEventDelivery(small)).toEqual(small);
  expect(() => boundedEventDelivery({ ...small, events: [] })).toThrow(
    "A run event exceeds the delivery size limit.",
  );
  const event = small.events[0];
  if (event?.eventType !== "tool-finished") throw new Error("Missing event");
  expect(() =>
    boundedEventDelivery({
      ...small,
      events: [{ ...event, result: "x".repeat(MAX_RUN_EVENTS_REQUEST_BYTES) }],
    }),
  ).toThrow("A run event exceeds the delivery size limit.");
});
it.each(["\u0000", "é", "😀"])(
  "bounds escaped UTF-8 payloads using a deterministic contiguous prefix: %s",
  (character) => {
    const input = request(character.repeat(32768), 32);
    const before = JSON.stringify(input);
    const output = boundedEventDelivery(input);
    expect(output.events.length).toBeGreaterThan(0);
    expect(output.events.length).toBeLessThan(input.events.length);
    expect(size(output)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(
      size({ ...output, events: input.events.slice(0, output.events.length + 1) }),
    ).toBeGreaterThan(2 * 1024 * 1024);
    expect(output.events).toEqual(input.events.slice(0, output.events.length));
    expect(JSON.stringify(input)).toBe(before);
    expect(boundedEventDelivery(input)).toEqual(output);
  },
);
it("accepts the exact transport limit and excludes an event that exceeds it by one byte", () => {
  const full = request("x".repeat(65536), 32);
  const last = full.events.at(-1);
  if (last?.eventType !== "tool-finished") throw new Error("Missing final event");
  const exact = {
    ...full,
    events: [
      ...full.events.slice(0, -1),
      { ...last, result: last.result.slice(0, 65536 - (size(full) - 2 * 1024 * 1024)) },
    ],
  };
  expect(size(exact)).toBe(2 * 1024 * 1024);
  expect(MAX_RUN_EVENTS_REQUEST_BYTES).toBe(2 * 1024 * 1024);
  expect(boundedEventDelivery(exact)).toEqual(exact);
  const final = exact.events.at(-1);
  if (final?.eventType !== "tool-finished") throw new Error("Missing exact final event");
  const larger = {
    ...exact,
    events: [...exact.events.slice(0, -1), { ...final, result: final.result + "x" }],
  };
  expect(boundedEventDelivery(larger).events).toEqual(exact.events.slice(0, -1));
});

it("admits a maximal valid structured-question event as one complete upload", () => {
  const input = AppendRunEventsRequestSchema.parse({
    ...request("unused", 1),
    events: [
      {
        eventType: "questions-resolved",
        eventId: "event:questions",
        sequence: 1,
        occurredAt: "2026-09-04T10:00:00.000Z",
        messageId: "message:questions",
        interruptId: "interrupt:questions",
        questions: Array.from({ length: 12 }, () => ({
          text: "\u0000".repeat(4096),
          choices: Array.from({ length: 20 }, () => "\u0000".repeat(1024)),
          required: true,
        })),
        answers: Array.from({ length: 12 }, () => "\u0000".repeat(4096)),
        cancelled: false,
      },
    ],
  });
  expect(size(input)).toBeGreaterThan(1024 * 1024);
  expect(size(input)).toBeLessThanOrEqual(MAX_RUN_EVENTS_REQUEST_BYTES);
  expect(boundedEventDelivery(input)).toEqual(input);
});
