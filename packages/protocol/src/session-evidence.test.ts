import { expect, it } from "vitest";
import { CanonicalRunEventSchema, MAX_RUN_EVENTS_REQUEST_BYTES } from "./events.js";
const base = { eventId: "event:evidence", sequence: 1, occurredAt: "2026-09-20T10:00:00.000Z" };
const events = {
  progress: {
    ...base,
    eventType: "assistant-progress",
    messageId: "message:one",
    content: "",
    truncated: false,
  },
  diagnostic: {
    ...base,
    eventType: "model-diagnostic",
    requestId: "request:one",
    phase: "request",
    status: "started",
    content: "",
    truncated: false,
  },
  context: { ...base, eventType: "project-context", cwd: "", branch: "", repositoryUrl: "" },
  change: {
    ...base,
    eventType: "project-change",
    actor: "student",
    patch: "",
    summary: "",
    truncated: false,
  },
  ended: { ...base, eventType: "turn-ended", messageId: "message:one", state: "completed" },
  failed: {
    ...base,
    eventType: "turn-failed",
    messageId: "message:one",
    category: "failure",
    retryable: false,
  },
};
it.each(Object.values(events))("keeps %s strict, immutable and lossless", (event) => {
  const parsed = CanonicalRunEventSchema.parse(event);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(parsed).toEqual(event);
  expect(CanonicalRunEventSchema.safeParse({ ...event, unexpected: true }).success).toBe(false);
  expect(CanonicalRunEventSchema.safeParse({ ...event, eventType: "" }).success).toBe(false);
});
it.each([
  [events.progress, "content", 16384],
  [events.diagnostic, "content", 16384],
  [events.context, "cwd", 512],
  [events.context, "branch", 128],
  [events.context, "repositoryUrl", 256],
  [events.change, "patch", 65536],
  [events.change, "summary", 4096],
  [events.failed, "category", 128],
] as const)("bounds %s field %s", (event, field, maximum) => {
  for (const [size, accepted] of [
    [0, field !== "category"],
    [1, true],
    [maximum, true],
    [maximum + 1, false],
  ] as const) {
    expect(CanonicalRunEventSchema.safeParse({ ...event, [field]: "x".repeat(size) }).success).toBe(
      accepted,
    );
  }
});
it("retains every outcome and attribution and rejects unknown values", () => {
  const cases = [
    [events.change, "actor", ["student", "agent", "unknown"]],
    [events.ended, "state", ["completed", "cancelled"]],
    [events.diagnostic, "phase", ["request", "response"]],
    [events.diagnostic, "status", ["started", "completed", "failed", "interrupted"]],
  ] as const;
  for (const [event, field, values] of cases) {
    for (const value of values)
      expect(CanonicalRunEventSchema.safeParse({ ...event, [field]: value }).success).toBe(true);
    expect(CanonicalRunEventSchema.safeParse({ ...event, [field]: "invalid" }).success).toBe(false);
  }
  expect(
    CanonicalRunEventSchema.parse({ ...events.change, messageId: "message:linked" }),
  ).toMatchObject({ messageId: "message:linked" });
  expect(CanonicalRunEventSchema.safeParse({ ...events.change, messageId: "" }).success).toBe(
    false,
  );
});

it("shares the two-mebibyte run event transport limit", () => {
  expect(MAX_RUN_EVENTS_REQUEST_BYTES).toBe(2097152);
});

it("accepts legacy tool calls and preserves exact tutor text boundaries on new ones", () => {
  const call = {
    ...base,
    eventType: "tool-started",
    messageId: "message:one",
    callId: "read",
    name: "marea_read_project",
    target: "/",
    arguments: "{}",
    truncated: false,
  };
  expect(CanonicalRunEventSchema.parse(call)).toEqual(call);
  for (const assistantTextOffset of [0, 17000]) {
    expect(CanonicalRunEventSchema.parse({ ...call, assistantTextOffset })).toEqual({
      ...call,
      assistantTextOffset,
    });
  }
  for (const assistantTextOffset of [-1, 1.5]) {
    expect(CanonicalRunEventSchema.safeParse({ ...call, assistantTextOffset }).success).toBe(false);
  }
});
