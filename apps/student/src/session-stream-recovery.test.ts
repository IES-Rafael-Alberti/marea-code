import { ModelStreamError } from "@marea/deepagents-adapter";
import { expect, it } from "vitest";
import { FixtureAgent, createFixtureController } from "./student.fixture.js";
import { TurnAttemptFailed } from "./contracts.js";
import { captureRejection } from "./session-test.boundary.js";
it("persists partial deltas across a transient failure and resumes their exact text", async () => {
  const agent = new FixtureAgent();
  let firstAttempt = true;
  agent.streamMessage = async function* (turn) {
    await Promise.resolve();
    this.messageTurns.push(turn);
    this.messages += 1;
    if (firstAttempt) {
      firstAttempt = false;
      yield { type: "assistant-text-delta", text: "Partial " };
      yield { type: "assistant-text-delta", text: "answer" };
      throw new ModelStreamError({
        code: "unavailable",
        message: "agent unavailable",
        retryable: true,
      });
    }
    yield { type: "assistant-text-delta", text: " complete" };
    yield { type: "turn-completed" };
  };
  const fixture = createFixtureController({ agent });
  await fixture.controller.start("Project One");

  const partialRejection = await captureRejection(
    fixture.controller.sendMessage("message:partial-retry", "Retry.", new AbortController().signal),
  );
  expect(partialRejection).toBeInstanceOf(TurnAttemptFailed);
  if (partialRejection instanceof TurnAttemptFailed) {
    expect(partialRejection.prefix).toBe("Partial answer");
    expect(partialRejection.cause.message).toBe(
      "The Marea model gateway reported a failed stream.",
    );
  }
  expect(fixture.state.state.run?.turns.at(-1)).toEqual({
    messageId: "message:partial-retry",
    state: "started",
    lastFailure: {
      code: "unavailable",
      detail: "agent unavailable",
      hasPrefix: true,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: true,
    },
    studentText: "Retry.",
    text: "Partial answer",
  });

  await fixture.controller.sendMessage(
    "message:partial-retry",
    "Retry.",
    new AbortController().signal,
  );

  expect(fixture.state.state.run?.turns.at(-1)).toEqual({
    messageId: "message:partial-retry",
    state: "completed",
    studentText: "Retry.",
    text: "Partial answer complete",
  });
  expect(
    [...fixture.server.events.values()].find((event) => event.eventType === "assistant-message"),
  ).toMatchObject({
    content: "Partial answer complete",
    eventType: "assistant-message",
  });
});
