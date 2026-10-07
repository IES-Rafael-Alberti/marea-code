import { expect, it } from "vitest";
import { CanonicalRunEventSchema, EventIdSchema } from "@marea/protocol";
import { buildSessionTrace, traceKey } from "./trace-builder.js";
import { redactTrace } from "./redaction.js";
import type { TraceTurn } from "./contracts.js";
import type { ExportUsage } from "../session-export/contracts.js";
const start = "2026-10-08T00:00:00.000Z",
  end = "2026-10-08T00:00:01.000Z";
const event = (sequence: number, body: object) =>
  CanonicalRunEventSchema.parse({
    eventId: `event:${String(sequence)}`,
    sequence,
    occurredAt: start,
    ...body,
  });
const base: Omit<TraceTurn, "events"> = {
  runId: "run:synthetic",
  studentId: "student:synthetic",
  classId: "class:synthetic",
  model: "model-test",
  provider: "provider-test",
  usage: [],
};
const usage: ExportUsage = {
  requestId: "request:one",
  attempt: 1,
  purpose: "tutoring",
  state: "settled",
  inputTokens: 3,
  outputTokens: 7,
  costUnits: 10,
  costUnit: "test-units",
  startedAt: start,
  endedAt: end,
};
it("links model attempts, tools, approvals and questions under a stable turn with truthful usage", () => {
  const events = [
    event(1, { eventType: "student-message", messageId: "message:one", content: "Student input" }),
    event(2, {
      eventType: "model-diagnostic",
      requestId: "request:one",
      phase: "request",
      status: "started",
      content: "model input",
      truncated: true,
    }),
    event(3, {
      eventType: "model-diagnostic",
      requestId: "request:one",
      phase: "response",
      status: "failed",
      content: "model output",
      truncated: true,
      occurredAt: end,
    }),
    event(4, {
      eventType: "tool-started",
      messageId: "message:one",
      callId: "call:one",
      name: "write",
      target: "x.py",
      arguments: "tool input",
      truncated: false,
    }),
    event(5, {
      eventType: "tool-finished",
      messageId: "message:one",
      callId: "call:one",
      failed: true,
      result: "tool failure",
      truncated: true,
      occurredAt: end,
    }),
    event(6, {
      eventType: "approval-requested",
      messageId: "message:one",
      approvalId: "approval:one",
      tool: "write",
      summary: "approval",
      truncated: false,
    }),
    event(7, {
      eventType: "approval-resolved",
      approvalId: "approval:one",
      decision: "rejected",
      occurredAt: end,
    }),
    event(8, {
      eventType: "questions-resolved",
      messageId: "message:one",
      interruptId: "q",
      questions: [{ text: "Which?", choices: ["A"], required: true }],
      answers: ["A"],
      cancelled: false,
    }),
    event(9, {
      eventType: "assistant-message",
      messageId: "message:one",
      content: "Assistant answer",
    }),
    event(10, {
      eventType: "turn-failed",
      messageId: "message:one",
      category: "provider",
      retryable: true,
      occurredAt: end,
    }),
  ];
  const trace = buildSessionTrace(
    {
      ...base,
      events,
      usage: [
        usage,
        {
          ...usage,
          attempt: 2,
          state: "unknown",
          costUnits: null,
          inputTokens: null,
          outputTokens: null,
          endedAt: null,
        },
      ],
    },
    "namespace",
    "release",
  );
  expect(trace).toMatchSnapshot("linked turn with attempts, failure and all content");
  expect(trace.id).toBe(traceKey("namespace", base.runId, "message:one"));
  expect(trace.spans).toHaveLength(8);
  const root = trace.spans[0],
    generation = trace.spans[1];
  expect(root).toMatchObject({
    type: "agent",
    input: "Student input",
    output: "Assistant answer",
    startedAt: start,
    endedAt: end,
    failed: true,
  });
  expect(generation).toMatchObject({
    parentId: root?.id,
    type: "span",
    model: "model-test",
    metadata: { truncated: true, complete: true },
  });
  expect(trace.spans[2]).toMatchObject({
    parentId: generation?.id,
    type: "generation",
    startedAt: start,
    endedAt: end,
    output: "",
    usage: { input: 3, output: 7 },
    metadata: { costUnit: "test-units", costUnits: 10, timingComplete: true },
  });
  expect(trace.spans[3]).toMatchObject({
    parentId: generation?.id,
    output: "model output",
    failed: true,
    endedAt: undefined,
    metadata: { costUnits: "unknown", timingComplete: false },
  });
  expect(trace.spans[3]).not.toHaveProperty("usage");
  expect(trace.spans[4]).toMatchObject({
    type: "tool",
    input: "tool input",
    output: "tool failure",
    failed: true,
    metadata: { truncated: true },
  });
  expect(trace.spans[5]?.output).toContain('"decision":"rejected"');
  expect(trace.spans[6]?.output).toContain('"answers":["A"]');
  expect(buildSessionTrace({ ...base, events }, "namespace", "release").id).toBe(trace.id);
  expect(buildSessionTrace({ ...base, events }, "other-installation", "release").id).not.toBe(
    trace.id,
  );
});
it("marks incomplete old diagnostics without inventing output, usage, or negative durations", () => {
  const events = [
    event(1, { eventType: "student-message", content: "legacy", occurredAt: end }),
    event(2, {
      eventType: "model-diagnostic",
      requestId: "request:one",
      phase: "request",
      status: "started",
      content: "request",
      truncated: false,
    }),
    event(3, {
      eventType: "tool-started",
      messageId: "m",
      callId: "missing",
      name: "read",
      target: "x",
      arguments: "{}",
      truncated: false,
    }),
    event(4, {
      eventType: "approval-requested",
      approvalId: "a",
      tool: "read",
      summary: "missing resolution",
    }),
    event(5, { eventType: "assistant-message", content: "legacy answer" }),
  ];
  const trace = buildSessionTrace({ ...base, events }, "namespace", "release");
  expect(trace).toMatchSnapshot("incomplete legacy observations");
  expect(trace.spans[0]).toMatchObject({ endedAt: end, metadata: { clockSkew: true } });
  expect(trace.spans[1]).toMatchObject({
    type: "generation",
    output: "",
    metadata: { complete: false, truncated: false },
  });
  expect(trace.spans.slice(2).every((s) => s.output === "")).toBe(true);
  const mixed = buildSessionTrace(
    { ...base, events, usage: [{ ...usage, outputTokens: null }] },
    "namespace",
    "release",
  );
  expect(mixed.spans[2]).not.toHaveProperty("usage");
  const point = buildSessionTrace(
    { ...base, events: [event(1, { eventType: "internal-activity" })] },
    "n",
    "v",
  );
  expect(point.spans).toHaveLength(1);
  expect(() => buildSessionTrace({ ...base, events: [] }, "n", "v")).toThrow("Empty trace");
  const skew = [
    event(1, {
      eventType: "tool-started",
      messageId: "m",
      callId: "c",
      name: "read",
      target: "x",
      arguments: "{}",
      truncated: false,
      occurredAt: end,
    }),
    event(2, {
      eventType: "tool-finished",
      messageId: "m",
      callId: "c",
      result: "ok",
      failed: false,
      truncated: false,
    }),
  ];
  expect(buildSessionTrace({ ...base, events: skew }, "n", "v").spans[1]).toMatchObject({
    endedAt: end,
    metadata: { clockSkew: true },
    failed: false,
  });
});
it("masks configured keys and common pasted credentials while preserving content and numeric metadata", () => {
  const original = buildSessionTrace(
    {
      ...base,
      events: [
        event(1, {
          eventType: "student-message",
          content: "key-value Bearer abc123 and sk-lf-abcdefghijklmnop",
        }),
      ],
    },
    "n",
    "v",
  );
  const trace = redactTrace(
    {
      ...original,
      spans: original.spans.map((s) => ({
        ...s,
        output: "Basic YWJjMTIz key-value",
        metadata: { code: "key-value", number: 3 },
      })),
    },
    ["", "key-value"],
  );
  expect(trace.spans[0]).toMatchObject({
    input: "[REDACTED] Bearer [REDACTED] and [REDACTED]",
    output: "Basic [REDACTED] [REDACTED]",
    metadata: { code: "[REDACTED]", number: 3 },
  });
  expect(original.spans[0]?.input).toContain("key-value");
});

it("uses the terminal sequence when a legacy message explicitly has no message ID", () => {
  const trace = buildSessionTrace(
    {
      ...base,
      events: [
        event(3, { eventType: "assistant-message", messageId: undefined, content: "legacy" }),
      ],
    },
    "namespace",
    "release",
  );
  expect(trace.id).toBe(traceKey("namespace", base.runId, 3));
});

it("keeps multi-message content separated and records stable names, pseudonyms and synthetic test identity", () => {
  const trace = buildSessionTrace(
    {
      ...base,
      events: [
        event(1, { eventType: "student-message", content: "one" }),
        event(2, { eventType: "student-message", content: "two" }),
        event(3, { eventType: "assistant-message", content: "three" }),
        event(4, { eventType: "assistant-message", content: "four" }),
      ],
    },
    "namespace",
    "release",
  );
  expect(trace).toMatchSnapshot("legacy turn without diagnostics and multiple messages");
});

it("rejects incomplete event arrays with an explicit trace error", () => {
  const firstMissing: TraceTurn["events"][number][] = [];
  firstMissing[1] = event(2, { eventType: "internal-activity" });
  const lastMissing = [event(1, { eventType: "internal-activity" })];
  lastMissing.length = 2;
  for (const events of [firstMissing, lastMissing])
    expect(() => buildSessionTrace({ ...base, events }, "n", "r")).toThrow("Empty trace.");
});

it("redacts generic keys and credentials separated by repeated whitespace", () => {
  const trace = buildSessionTrace(
    {
      ...base,
      events: [
        event(1, {
          eventType: "student-message",
          content: "Bearer  abc123 Basic\t  YWJj sk-abcdefghijklmnop",
        }),
      ],
    },
    "n",
    "r",
  );
  expect(redactTrace(trace, []).spans[0]?.input).toBe(
    "Bearer [REDACTED] Basic [REDACTED] [REDACTED]",
  );
});

it("matches distinct calls by kind and ID and keeps unrelated evaluation usage out of tutoring attempts", () => {
  const events = [
    event(1, { eventType: "student-message", messageId: "m", content: "input" }),
    event(2, {
      eventType: "model-diagnostic",
      requestId: "request:one",
      phase: "request",
      status: "started",
      content: "one",
      truncated: false,
    }),
    event(3, {
      eventType: "model-diagnostic",
      requestId: "request:two",
      phase: "request",
      status: "started",
      content: "two",
      truncated: true,
    }),
    event(4, {
      eventType: "model-diagnostic",
      requestId: "request:two",
      phase: "response",
      status: "completed",
      content: "second reply",
      truncated: false,
    }),
    event(5, {
      eventType: "model-diagnostic",
      requestId: "request:one",
      phase: "response",
      status: "completed",
      content: "first reply",
      truncated: true,
    }),
    event(6, {
      eventType: "tool-started",
      messageId: "m",
      callId: "first",
      name: "read",
      target: "a",
      arguments: "first",
      truncated: true,
    }),
    event(7, {
      eventType: "tool-started",
      messageId: "m",
      callId: "second",
      name: "read",
      target: "b",
      arguments: "second",
      truncated: false,
    }),
    event(8, {
      eventType: "tool-finished",
      messageId: "m",
      callId: "second",
      result: "second result",
      failed: false,
      truncated: false,
    }),
    event(9, {
      eventType: "tool-finished",
      messageId: "m",
      callId: "first",
      result: "first result",
      failed: false,
      truncated: false,
    }),
    event(10, {
      eventType: "approval-requested",
      approvalId: "first",
      tool: "read",
      summary: "first",
    }),
    event(11, {
      eventType: "approval-requested",
      approvalId: "second",
      tool: "read",
      summary: "second",
    }),
    event(12, { eventType: "approval-resolved", approvalId: "second", decision: "approved" }),
    event(13, { eventType: "approval-resolved", approvalId: "first", decision: "rejected" }),
    event(14, {
      eventType: "project-change",
      actor: "student",
      patch: "+print()",
      summary: "edit",
      truncated: false,
    }),
    event(15, {
      eventType: "workspace-edit",
      approvalId: "first",
      operation: "created",
      path: "x.py",
      digest: `sha256:${"a".repeat(64)}`,
    }),
    event(16, { eventType: "turn-ended", messageId: "m", state: "completed" }),
  ];
  const attempts = [
    usage,
    { ...usage, attempt: 2 },
    { ...usage, attempt: 3 },
    { ...usage, requestId: "request:other" },
    { ...usage, purpose: "evaluation" },
    { ...usage, requestId: "request:two", inputTokens: null },
  ];
  expect(buildSessionTrace({ ...base, events, usage: attempts }, "n", "r")).toMatchSnapshot(
    "independent model calls, three retries, tools and approvals",
  );
  const activity = event(17, { eventType: "internal-activity" });
  if (activity.eventType !== "internal-activity") throw new Error("fixture");
  const extra = {
    ...activity,
    requestId: "request:one",
    phase: "response",
    callId: "first",
    approvalId: "first",
  };
  const extraRequest = {
    ...extra,
    eventId: EventIdSchema.parse("extra-request"),
    phase: "request",
  };
  const clean = buildSessionTrace({ ...base, events, usage: attempts }, "n", "r");
  const extended = buildSessionTrace(
    { ...base, events: [extra, extraRequest, ...events], usage: attempts },
    "n",
    "r",
  );
  expect(extended.spans.slice(1)).toStrictEqual(clean.spans.slice(1));
});
