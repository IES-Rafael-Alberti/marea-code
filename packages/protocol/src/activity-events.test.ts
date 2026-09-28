import { expect, it } from "vitest";
import { CanonicalRunEventSchema } from "./events.js";
const base = {
  eventId: "event:1",
  sequence: 1,
  occurredAt: "2026-09-20T00:00:00.000Z",
  messageId: "message:1",
};
const call = {
  ...base,
  eventType: "tool-started",
  callId: "c1",
  name: "marea_read_skill",
  target: "SKILL.md",
  arguments: "{}",
  truncated: false,
};
const result = {
  ...base,
  eventType: "tool-finished",
  callId: "c1",
  result: "",
  failed: false,
  truncated: false,
};
const question = { text: "Why?", choices: ["A"], required: true };
const answers = {
  ...base,
  eventType: "questions-resolved",
  interruptId: "q1",
  questions: [question],
  answers: ["A"],
  cancelled: false,
};
it.each([call, result, answers])("accepts immutable, strict activity %s", (event) => {
  const parsed = CanonicalRunEventSchema.parse(event);
  expect(parsed).toEqual(event);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(CanonicalRunEventSchema.safeParse({ ...event, secret: "invalid" }).success).toBe(false);
});
it.each([
  [call, "callId", 512, false],
  [call, "target", 2048, true],
  [call, "arguments", 65_536, true],
  [result, "callId", 512, false],
  [result, "result", 65_536, true],
  [answers, "interruptId", 512, false],
] as const)("enforces bounded activity strings", (event, field, limit, empty) => {
  expect(CanonicalRunEventSchema.safeParse({ ...event, [field]: "x".repeat(limit) }).success).toBe(
    true,
  );
  expect(
    CanonicalRunEventSchema.safeParse({ ...event, [field]: "x".repeat(limit + 1) }).success,
  ).toBe(false);
  expect(CanonicalRunEventSchema.safeParse({ ...event, [field]: "" }).success).toBe(empty);
  expect(CanonicalRunEventSchema.safeParse({ ...event, [field]: 1 }).success).toBe(false);
});
it("keeps complete bounded question choices and answers without arbitrary fields", () => {
  const parse = (change: object) =>
    CanonicalRunEventSchema.safeParse({ ...answers, ...change }).success;
  expect(parse({ questions: [] })).toBe(false);
  expect(parse({ questions: Array.from({ length: 12 }, () => question) })).toBe(true);
  expect(parse({ questions: Array.from({ length: 13 }, () => question) })).toBe(false);
  for (const [field, limit] of [
    ["text", 4096],
    ["choices", 1024],
  ] as const) {
    for (const [length, valid] of [
      [0, false],
      [limit, true],
      [limit + 1, false],
    ] as const) {
      const value = "x".repeat(length);
      expect(
        parse({ questions: [{ ...question, [field]: field === "choices" ? [value] : value }] }),
      ).toBe(valid);
    }
  }
  expect(parse({ questions: [{ ...question, choices: [] }] })).toBe(true);
  expect(
    parse({ questions: [{ ...question, choices: Array.from({ length: 20 }, () => "x") }] }),
  ).toBe(true);
  expect(
    parse({ questions: [{ ...question, choices: Array.from({ length: 21 }, () => "x") }] }),
  ).toBe(false);
  expect(parse({ questions: [{ ...question, extra: "bad" }] })).toBe(false);
  expect(parse({ answers: [] })).toBe(true);
  expect(parse({ answers: Array.from({ length: 12 }, () => "") })).toBe(true);
  expect(parse({ answers: Array.from({ length: 13 }, () => "") })).toBe(false);
  expect(parse({ answers: ["x".repeat(4096)] })).toBe(true);
  expect(parse({ answers: ["x".repeat(4097)] })).toBe(false);
  const parsed = CanonicalRunEventSchema.parse(answers);
  if (parsed.eventType !== "questions-resolved") throw new Error("Expected questions");
  expect(Object.isFrozen(parsed.questions)).toBe(true);
  expect(Object.isFrozen(parsed.questions[0])).toBe(true);
  expect(Object.isFrozen(parsed.questions[0]?.choices)).toBe(true);
  expect(Object.isFrozen(parsed.answers)).toBe(true);
});
it("allows a detail-free sequence-preserving activity marker", () => {
  const event = {
    eventType: "internal-activity",
    eventId: base.eventId,
    sequence: 1,
    occurredAt: base.occurredAt,
  };
  expect(CanonicalRunEventSchema.parse(event)).toEqual(event);
  expect(Object.isFrozen(CanonicalRunEventSchema.parse(event))).toBe(true);
  expect(CanonicalRunEventSchema.safeParse({ ...event, content: "private" }).success).toBe(false);
});
it("supports optional proposal content and rejection explanation without breaking old events", () => {
  const approval = {
    ...base,
    eventType: "approval-requested",
    approvalId: "approval:1",
    tool: "write_file",
    summary: "Write",
  };
  expect(CanonicalRunEventSchema.safeParse(approval).success).toBe(true);
  expect(
    CanonicalRunEventSchema.safeParse({ ...approval, content: "", truncated: false, path: "a.py" })
      .success,
  ).toBe(true);
  expect(
    CanonicalRunEventSchema.safeParse({ ...approval, content: "x".repeat(65_536) }).success,
  ).toBe(true);
  expect(
    CanonicalRunEventSchema.safeParse({ ...approval, content: "x".repeat(65_537) }).success,
  ).toBe(false);
  const resolved = {
    ...base,
    eventType: "approval-resolved",
    approvalId: "approval:1",
    decision: "rejected",
  };
  expect(CanonicalRunEventSchema.safeParse({ ...resolved, reason: "x".repeat(4096) }).success).toBe(
    true,
  );
  expect(CanonicalRunEventSchema.safeParse({ ...resolved, reason: "x".repeat(4097) }).success).toBe(
    false,
  );
});
