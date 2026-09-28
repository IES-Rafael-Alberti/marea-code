import { expect, it } from "vitest";
import { CanonicalRunEventSchema } from "@marea/protocol";
import { conversationToolGroups } from "./conversation-tool-groups.js";

function call(sequence: number, callId: string, messageId = "message:one") {
  return CanonicalRunEventSchema.parse({
    eventId: `event:${String(sequence)}`,
    sequence,
    messageId,
    callId,
    occurredAt: "2026-09-21T17:16:25.001Z",
    eventType: "tool-started",
    name: "marea_read_project",
    target: `/${callId}`,
    arguments: "{}",
    truncated: false,
  });
}
function result(sequence: number, callId: string, messageId = "message:one", failed = false) {
  return CanonicalRunEventSchema.parse({
    eventId: `event:${String(sequence)}`,
    sequence,
    messageId,
    callId,
    occurredAt: "2026-09-21T17:16:25.999Z",
    eventType: "tool-finished",
    result: `output:${callId}`,
    failed,
    truncated: false,
  });
}

it.each([false, true])(
  "pairs parallel reads by identity even when results finish in reverse (%s)",
  (reverse) => {
    const a = call(1, "a");
    const b = call(2, "b");
    const aResult = result(reverse ? 4 : 3, "a");
    const bResult = result(reverse ? 3 : 4, "b", "message:one", true);
    const events = Object.freeze([a, b, ...(reverse ? [bResult, aResult] : [aResult, bResult])]);
    const original = JSON.stringify(events);
    expect(conversationToolGroups(events)).toEqual([
      { event: a, result: aResult },
      { event: b, result: bResult },
    ]);
    expect(JSON.stringify(events)).toBe(original);
  },
);

it("fills pending calls across history pages without hiding orphan results or crossing turns", () => {
  const a = call(1, "shared");
  const b = call(2, "shared", "message:two");
  const orphan = result(3, "missing");
  const bResult = result(4, "shared", "message:two");
  expect(conversationToolGroups([a, b])).toEqual([{ event: a }, { event: b }]);
  expect(conversationToolGroups([a, b, orphan, bResult])).toEqual([
    { event: a },
    { event: b, result: bResult },
    { event: orphan },
  ]);
});

it("preserves messages between calls and shows unmatched or duplicate results", () => {
  const a = call(1, "a");
  const text = CanonicalRunEventSchema.parse({
    eventId: "event:2",
    sequence: 2,
    occurredAt: "2026-09-21T17:16:25.100Z",
    eventType: "assistant-message",
    content: "Reading another file",
    messageId: "message:one",
  });
  const b = call(3, "b");
  const aResult = result(4, "a");
  const duplicate = result(5, "a");
  expect(conversationToolGroups([a, text, b, aResult, duplicate])).toEqual([
    { event: a, result: aResult },
    { event: text },
    { event: b },
    { event: duplicate },
  ]);
});

it("never pairs ordinary messages or orphan results with each other", () => {
  const messages = [1, 2].map((sequence) =>
    CanonicalRunEventSchema.parse({
      eventId: `event:plain-${String(sequence)}`,
      sequence,
      occurredAt: "2026-09-22T10:00:00.000Z",
      eventType: "assistant-message",
      content: `Message ${String(sequence)}`,
      messageId: "message:plain",
    }),
  );
  const events = [...messages, result(3, "orphan"), result(4, "orphan")];
  expect(conversationToolGroups(events)).toEqual(events.map((event) => ({ event })));
});

it("retains repeated starts rather than treating a start as a result", () => {
  const first = call(1, "repeated");
  const second = call(2, "repeated");
  const completion = result(3, "repeated");
  expect(conversationToolGroups([first, second, completion])).toEqual([
    { event: first },
    { event: second, result: completion },
  ]);
});
