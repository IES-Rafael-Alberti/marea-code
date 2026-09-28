import type { ConversationTuiOptions, ConversationTuiSession } from "@marea/student-tui";
import { TurnFailureSignal } from "@marea/student-tui";
import { describe, expect, it } from "vitest";

import { commandOptions, testConversationRuntime } from "./command-options.fixture.js";
import { executeMareaCommand, type MareaCommandRuntime } from "./marea-command.boundary.js";
import { captureRejection } from "./session-test.boundary.js";

describe("marea command failure classification", () => {
  it("classifies a failed turn through the conversation boundary", async () => {
    const exit = Promise.withResolvers<{ readonly exitCode: 0; readonly reason: "closed" }>();
    const session: ConversationTuiSession = {
      appendAssistantText: () => true,
      cancel: () => true,
      close: () => true,
      complete: () => true,
      fail: () => true,
      outcome: exit.promise,
      requestApproval: () => Promise.reject(new Error("no approvals in this journey")),
      resumeTurn: () => true,
      snapshot: () => ({ approval: null, messages: [], status: "ready" as const }),
      thinking: () => true,
      toolFinished: () => true,
      toolStarted: () => true,
    };
    const controller = {
      close: () => Promise.resolve(),
      pendingTurn: () => Promise.resolve(null),
      sendMessage: () => Promise.reject(new Error("connection lost")),
      start: () =>
        Promise.resolve({
          classroomDisplayName: "Physics",
          projectDisplayName: "project-one",
          runId: "run:1",
          snapshot: { modelAlias: "marea" },
        }),
    };
    const started = Promise.withResolvers<ConversationTuiOptions>();
    const runtime: MareaCommandRuntime = {
      createApplication: () => Promise.resolve({ controller, dispose: () => undefined }),
      ...testConversationRuntime((options) => {
        started.resolve(options);
        return Promise.resolve(session);
      }),
    };

    const execution = executeMareaCommand(commandOptions(), runtime);
    const startedOptions = await started.promise;
    const rejection = await captureRejection(
      startedOptions.onMessage("Try.", new AbortController().signal, "message:one", "attempt:one"),
    );
    expect(rejection).toBeInstanceOf(TurnFailureSignal);
    if (rejection instanceof TurnFailureSignal) {
      expect(rejection.failure).toEqual({
        detail: "Error: connection lost",
        hasPrefix: false,
        kind: "unexpected",
        recoverable: true,
        retryable: false,
      });
    }
    exit.resolve({ exitCode: 0, reason: "closed" });
    await expect(execution).resolves.toBe(0);
  });
});
