import { expect, it } from "vitest";
import { CanonicalRunEventSchema } from "@marea/protocol";
import { conversationHistory } from "./conversation-history.js";

function historyEvents(payloads: readonly object[]) {
  return payloads.map((payload, index) =>
    CanonicalRunEventSchema.parse({
      messageId: "message:segmented",
      eventId: `event:segment-${String(index)}`,
      sequence: index + 1,
      occurredAt: `2026-09-22T10:00:0${String(index)}.000Z`,
      ...payload,
    }),
  );
}

function historyTool(callId: string, assistantTextOffset?: number) {
  return {
    eventType: "tool-started",
    callId,
    name: "marea_read_project",
    target: "/",
    arguments: "{}",
    truncated: false,
    ...(assistantTextOffset === undefined ? {} : { assistantTextOffset }),
  };
}

it("reconstructs live-only text and ignores later non-text events in its text lookup", () => {
  const events = historyEvents([
    historyTool("first", 6),
    { eventType: "assistant-progress", content: "BeforeAfter", truncated: false },
    {
      eventType: "tool-finished",
      callId: "first",
      result: "done",
      failed: false,
      truncated: false,
    },
  ]);
  const result = conversationHistory(events);
  expect(result.map((event) => event.eventType)).toEqual([
    "assistant-progress",
    "tool-started",
    "assistant-progress",
    "tool-finished",
  ]);
  expect(result[0]).toMatchObject({
    content: "Before",
    sequence: 1,
    occurredAt: events[0]?.occurredAt,
  });
  expect(result[2]).toMatchObject({
    content: "After",
    sequence: 2,
    occurredAt: events[1]?.occurredAt,
  });
});

it("preserves the first block timestamp and separates several legacy calls without offsets", () => {
  const events = historyEvents([
    { eventType: "assistant-progress", content: "One", truncated: false },
    { eventType: "assistant-progress", content: "One!", truncated: false },
    historyTool("first"),
    { eventType: "assistant-progress", content: "One!Two", truncated: false },
    historyTool("second"),
    { eventType: "assistant-message", content: "One!TwoThree" },
  ]);
  expect(conversationHistory(events)).toEqual([
    {
      ...events[5],
      content: "One!",
      eventId: events[0]?.eventId,
      sequence: 1,
      occurredAt: events[0]?.occurredAt,
    },
    events[2],
    {
      ...events[5],
      content: "Two",
      eventId: events[3]?.eventId,
      sequence: 4,
      occurredAt: events[3]?.occurredAt,
    },
    events[4],
    { ...events[5], content: "Three" },
  ]);
});

it("keeps calls with unavailable text and does not manufacture empty text blocks", () => {
  const events = historyEvents([historyTool("orphan", 42), historyTool("other", 42)]);
  expect(conversationHistory(events)).toEqual(events);
  const empty = historyEvents([
    { eventType: "assistant-progress", content: "", truncated: false },
    historyTool("empty", 0),
  ]);
  expect(conversationHistory(empty)).toEqual([empty[1]]);
});

it("does not split an existing text block when only a tool result arrives", () => {
  const events = historyEvents([
    { eventType: "assistant-progress", content: "A", truncated: false },
    {
      eventType: "tool-finished",
      callId: "orphan",
      result: "done",
      failed: false,
      truncated: false,
    },
    { eventType: "assistant-progress", content: "AB", truncated: false },
  ]);
  expect(conversationHistory(events)).toEqual([
    { ...events[2], eventId: events[0]?.eventId, sequence: 1, occurredAt: events[0]?.occurredAt },
    events[1],
  ]);
});

it.each([true, false])(
  "does not move future text ahead of a legacy initial call (empty progress: %s)",
  (progress) => {
    const events = historyEvents([
      ...(progress ? [{ eventType: "assistant-progress", content: "", truncated: false }] : []),
      historyTool("initial"),
      { eventType: "assistant-message", content: "Only after the call" },
    ]);
    expect(conversationHistory(events)).toEqual(events.slice(progress ? 1 : 0));
  },
);

it("updates text in place, uses the final durable answer and keeps internal exchanges out of the conversation", () => {
  const payloads = [
    { eventType: "student-message", content: "Question", messageId: "message:one" },
    { eventType: "assistant-progress", content: "Par", messageId: "message:one", truncated: false },
    {
      eventType: "model-diagnostic",
      phase: "response",
      requestId: "request:one",
      status: "completed",
      content: "private",
      truncated: false,
    },
    {
      eventType: "assistant-progress",
      content: "Partial",
      messageId: "message:one",
      truncated: false,
    },
    { eventType: "assistant-message", content: "Final answer", messageId: "message:one" },
    { eventType: "assistant-message", content: "Legacy message" },
    { eventType: "assistant-message", content: "Another legacy message" },
  ];
  const events = payloads.map((payload, index) =>
    CanonicalRunEventSchema.parse({
      ...payload,
      eventId: `event:${String(index)}`,
      sequence: index + 1,
      occurredAt: "2026-09-20T10:00:00.000Z",
    }),
  );
  expect(conversationHistory(events)).toEqual([
    events[0],
    { ...events[4], eventId: events[1]?.eventId, sequence: events[1]?.sequence },
    events[5],
    events[6],
  ]);
});

it.each([true, false])(
  "keeps speech around parallel tools in order (live progress: %s)",
  (live) => {
    const before = "I'll inspect the project.";
    const after = "I have read it. Here is the exercise.";
    const payloads = [
      ...(live ? [{ eventType: "assistant-progress", content: "I'll", truncated: false }] : []),
      {
        eventType: "tool-started",
        callId: "a",
        name: "marea_read_project",
        target: "/",
        arguments: "{}",
        truncated: false,
        assistantTextOffset: before.length,
      },
      {
        eventType: "tool-started",
        callId: "b",
        name: "marea_read_skill",
        target: "/",
        arguments: "{}",
        truncated: false,
        assistantTextOffset: before.length,
      },
      {
        eventType: "tool-finished",
        callId: "a",
        result: "project",
        failed: false,
        truncated: false,
      },
      { eventType: "tool-finished", callId: "b", result: "skill", failed: false, truncated: false },
      ...(live
        ? [{ eventType: "assistant-progress", content: before + "I have", truncated: false }]
        : []),
      { eventType: "assistant-message", content: before + after },
    ];
    const events = payloads.map((payload, index) =>
      CanonicalRunEventSchema.parse({
        ...payload,
        messageId: "message:tools",
        eventId: `event:${String(index)}`,
        sequence: index + 1,
        occurredAt: `2026-09-20T10:00:0${String(index)}.000Z`,
      }),
    );
    const history = conversationHistory(events);
    expect(history.map((event) => event.eventType)).toEqual([
      "assistant-message",
      "tool-started",
      "tool-started",
      "tool-finished",
      "tool-finished",
      "assistant-message",
    ]);
    expect(
      history
        .filter((event) => event.eventType === "assistant-message")
        .map((event) => event.content),
    ).toEqual([before, after]);
    expect(history[0]?.occurredAt).toBe(events[0]?.occurredAt);
    expect(new Set(history.map((event) => event.eventId)).size).toBe(history.length);
  },
);

it("splits long text exactly beyond truncated progress and does not repeat it after a final tool", () => {
  const content = "a".repeat(17000);
  const events = [
    { eventType: "assistant-progress", content: content.slice(0, 16384), truncated: true },
    {
      eventType: "tool-started",
      callId: "a",
      name: "marea_read_project",
      target: "/",
      arguments: "{}",
      truncated: false,
      assistantTextOffset: content.length,
    },
    { eventType: "assistant-message", content },
  ].map((payload, index) =>
    CanonicalRunEventSchema.parse({
      ...payload,
      messageId: "message:long",
      eventId: `event:${String(index)}`,
      sequence: index + 1,
      occurredAt: "2026-09-20T10:00:00.000Z",
    }),
  );
  expect(conversationHistory(events)).toMatchObject([
    { eventType: "assistant-message", content },
    { eventType: "tool-started" },
  ]);
});
