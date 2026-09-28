import { STARTUP_MESSAGE_ID } from "@marea/protocol";
import { expect, it } from "vitest";
import { pendingStoredTurn } from "./pending-turn.js";
import { createFixtureController } from "./student.fixture.js";

it.each([false, true])(
  "hydrates startup=%s with precisely the persisted failure, including absence",
  async (startup) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project");
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Missing fixture run");
    const turn = {
      messageId: startup ? STARTUP_MESSAGE_ID : "message:pending",
      state: "started" as const,
      ...(startup ? { kind: "startup" as const } : { studentText: "Input" }),
      text: "Saved",
    };
    const expected = {
      messageId: turn.messageId,
      assistantText: "Saved",
      text: startup ? "" : "Input",
      ...(startup ? { kind: "startup" } : {}),
    };
    expect(pendingStoredTurn({ ...run, turns: [turn] })).toStrictEqual(expected);
    const failure = {
      code: "unavailable",
      detail: "Interrupted",
      kind: "provider-interrupted" as const,
      hasPrefix: true,
      recoverable: true,
      retryable: true,
    };
    expect(pendingStoredTurn({ ...run, turns: [{ ...turn, lastFailure: failure }] })).toStrictEqual(
      { ...expected, failure },
    );
  },
);
