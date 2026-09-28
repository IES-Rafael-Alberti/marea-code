import { ModelStreamError } from "@marea/deepagents-adapter";
import { expect, it } from "vitest";
import { FixtureAgent, createFixtureController } from "./student.fixture.js";
import { TurnAttemptFailed } from "./contracts.js";

it.each(["deadline-exceeded", "budget-exhausted", "invalid-response"])(
  "persists %s and refuses a direct retry after restart",
  async (code) => {
    const agent = new FixtureAgent();
    let calls = 0;
    agent.streamMessage = async function* () {
      await Promise.resolve();
      calls += 1;
      yield { type: "assistant-text-delta", text: "Saved partial" };
      throw new ModelStreamError({ code, message: "No retry", retryable: false });
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");
    await expect(
      fixture.controller.sendMessage("message:refused", "Help", new AbortController().signal),
    ).rejects.toBeInstanceOf(TurnAttemptFailed);
    const failure = {
      code,
      detail: "No retry",
      hasPrefix: true,
      kind: code === "invalid-response" ? "request-failed" : code,
      recoverable: true,
      retryable: false,
    };
    expect(await fixture.controller.pendingTurn()).toEqual({
      messageId: "message:refused",
      text: "Help",
      assistantText: "Saved partial",
      failure,
    });
    const restarted = createFixtureController({
      agent,
      server: fixture.server,
      state: fixture.state,
      credentials: fixture.credentials,
    });
    await restarted.controller.start("Project One");
    await expect(
      restarted.controller.sendMessage("message:refused", "Help", new AbortController().signal),
    ).rejects.toMatchObject({ name: "StoredTurnFailure", failure });
    expect(calls).toBe(1);
    expect(await restarted.controller.pendingTurn()).toMatchObject({ failure });
  },
);

it("clears a transient failure durably before starting its explicitly requested retry", async () => {
  const agent = new FixtureAgent();
  const fixture = createFixtureController({ agent });
  let calls = 0;
  agent.streamMessage = async function* () {
    await Promise.resolve();
    calls += 1;
    if (calls === 1)
      throw new ModelStreamError({ code: "unavailable", message: "Transient", retryable: true });
    expect(fixture.state.state.run?.turns.at(-1)?.lastFailure).toBeUndefined();
    expect(Object.hasOwn(fixture.state.state.run?.turns.at(-1) ?? {}, "lastFailure")).toBe(false);
    yield { type: "turn-completed" };
  };
  await fixture.controller.start("Project");
  await expect(
    fixture.controller.sendMessage("message:transient", "Help", new AbortController().signal),
  ).rejects.toBeInstanceOf(TurnAttemptFailed);
  expect(await fixture.controller.pendingTurn()).toMatchObject({ failure: { retryable: true } });
  await fixture.controller.sendMessage("message:transient", "Help", new AbortController().signal);
  expect(calls).toBe(2);
});
