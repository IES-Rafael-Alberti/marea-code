import { expect, it, vi } from "vitest";
import { STARTUP_MESSAGE_ID, MessageIdSchema } from "@marea/protocol";
import { TeacherActivity } from "./teacher-activity.js";
import { failTurn } from "./turn-outcome.boundary.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";
import type { SessionTurnExecutorOptions } from "./session-turn-executor.js";
it("keeps failed startup attempts distinct while deduplicating terminal outcomes across retries", async () => {
  const f = createFixtureController();
  await f.controller.start("Outcomes");
  const activity = new TeacherActivity({
    localSession: f.localSession,
    ids: new FixtureIds(),
    flushOutbox: () => Promise.resolve(),
  });
  for (const attemptId of ["first", "second"]) {
    await activity.terminal(
      { messageId: STARTUP_MESSAGE_ID, attemptId },
      { eventType: "turn-failed", category: "offline", retryable: true },
    );
    await activity.terminal(
      { messageId: STARTUP_MESSAGE_ID, attemptId },
      { eventType: "turn-ended", state: "completed" },
    );
    await activity.terminal(
      { messageId: MessageIdSchema.parse("message:regular"), attemptId },
      { eventType: "turn-ended", state: "completed" },
    );
  }
  expect((await f.localSession.pendingEvents(128)).map((event) => event.eventType)).toEqual([
    "turn-failed",
    "turn-ended",
    "turn-failed",
  ]);
});
it("preserves the original failure if no durable turn can be found", async () => {
  const f = createFixtureController();
  await f.controller.start("Missing journal");
  const failure = new Error("original failure");
  const started = await f.controller.start("Missing journal");
  const options: SessionTurnExecutorOptions = {
    agent: f.agent,
    ids: new FixtureIds(),
    localSession: f.localSession,
    studentInterface: f.studentInterface,
    workspace: f.workspace,
    flushOutbox: vi.fn().mockRejectedValue(new Error("offline")),
    requireActiveRun: async () => ({ ...started, runToken: await f.controller.modelRunToken() }),
  };
  await expect(
    failTurn(
      options,
      { messageId: MessageIdSchema.parse("message:missing"), attemptId: "attempt" },
      "prefix",
      new AbortController().signal,
      failure,
    ),
  ).rejects.toMatchObject({ cause: failure, prefix: "prefix" });
});
