import { expect, it } from "vitest";

import { parseStudentState } from "./filesystem.boundary.js";
import { createFixtureController } from "./student.fixture.js";

it("bounds and freezes persisted failure metadata without weakening the state schema", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  const base = fixture.state.state;
  const failure = {
    code: "x".repeat(64),
    detail: "d".repeat(1024),
    hasPrefix: true,
    kind: "provider-interrupted",
    recoverable: true,
    retryable: false,
  };
  const parse = (lastFailure: object) =>
    parseStudentState({
      ...base,
      run: {
        ...base.run,
        turns: [
          {
            messageId: "message:failed",
            state: "started",
            text: "Saved",
            studentText: "Input",
            lastFailure,
          },
        ],
      },
    });
  for (const kind of [
    "provider-interrupted",
    "request-failed",
    "session-unavailable",
    "unexpected",
    "deadline-exceeded",
    "budget-exhausted",
    "concurrency-limited",
    "recovery-pending",
  ]) {
    const parsed = parse({ ...failure, kind });
    expect(parsed.run?.turns[0]?.lastFailure).toEqual({ ...failure, kind });
    expect(Object.isFrozen(parsed.run?.turns[0]?.lastFailure)).toBe(true);
  }
  expect(parse({ ...failure, code: undefined }).run?.turns[0]?.lastFailure?.code).toBeUndefined();
  for (const invalid of [
    { ...failure, code: "x".repeat(65) },
    { ...failure, detail: "d".repeat(1025) },
    { ...failure, code: 1 },
    { ...failure, detail: null },
    { ...failure, hasPrefix: "yes" },
    { ...failure, kind: "unknown" },
    { ...failure, recoverable: "yes" },
    { ...failure, retryable: "yes" },
    { ...failure, extra: true },
    {},
  ])
    expect(() => parse(invalid)).toThrow();
});
