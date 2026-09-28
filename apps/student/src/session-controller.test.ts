import { ModelStreamError } from "@marea/deepagents-adapter";
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";

import {
  FixtureAgent,
  FixtureInterface,
  FixtureServer,
  MemoryCredentialStore,
  SESSION_TOKEN,
  createFixtureController,
} from "./student.fixture.js";
import { TurnAttemptFailed } from "./contracts.js";
import { captureRejection } from "./session-test.boundary.js";

async function restartFixture(fixture: ReturnType<typeof createFixtureController>) {
  const restarted = createFixtureController({
    credentials: fixture.credentials,
    server: fixture.server,
    state: fixture.state,
  });
  await restarted.controller.start("Project One");
  return restarted;
}

describe("StudentSessionController", () => {
  it("enrolls once, resumes with its stored session, and completes an approved write", async () => {
    const first = createFixtureController();
    const session = await first.controller.start("Project One");
    const initialOpen = first.server.openRequests[0];

    expect(session.classroomDisplayName).toBe("Class One");
    expect(first.server.enrolled).toBe(1);
    expect(first.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(first.credentials.token).toBe(SESSION_TOKEN);
    expect(initialOpen).not.toHaveProperty("runId");

    const resumed = createFixtureController({
      credentials: first.credentials,
      server: first.server,
      state: first.state,
    });
    await resumed.controller.start("Project One");
    expect(resumed.studentInterface.authenticationReasons).toEqual([]);
    const resumeOpen = first.server.openRequests.at(-1);
    expect(resumeOpen?.intent).toEqual({ kind: "resume" });
    expect(resumeOpen?.runId).toBe(session.runId);
    expect(resumeOpen?.clientSessionId).not.toBe(initialOpen?.clientSessionId);
    expect(resumeOpen?.idempotencyKey).not.toBe(initialOpen?.idempotencyKey);
    expect(first.state.state.run?.openIntent).toEqual({ kind: "resume" });

    await resumed.controller.sendMessage(
      "message:1",
      "Please add notes.",
      new AbortController().signal,
      "attempt:primary",
    );

    expect(resumed.agent.messages).toBe(1);
    expect(resumed.agent.resumes).toBe(1);
    expect(resumed.workspace.writes).toBe(1);
    expect(resumed.studentInterface.approvals).toBe(1);
    const events = [...first.server.events.values()];
    expect(events.map((event) => event.eventType)).toEqual([
      "run-activated",
      "student-message",
      "approval-requested",
      "approval-resolved",
      "workspace-edit",
      "assistant-message",
      "turn-ended",
    ]);
    expect(resumed.agent.messageTurns).toEqual([
      {
        assistantText: "",
        messageId: "message:1",
        runId: session.runId,
        snapshot: session.snapshot,
        text: "Please add notes.",
      },
    ]);
    expect(resumed.agent.approvalTurns).toEqual([
      {
        approvalId: "approval:1",
        assistantText: "I will help. ",
        content: "New notes",
        decision: "approved",
        effect: { digest: `sha256:${"a".repeat(64)}`, operation: "created", path: "notes.txt" },
        messageId: "message:1",
        path: "notes.txt",
        runId: session.runId,
        snapshot: session.snapshot,
        summary: "Create notes.txt",
      },
    ]);
    expect(resumed.workspace.calls).toEqual([
      { content: "New notes", effectId: "effect:1", path: "notes.txt" },
    ]);
    expect(resumed.studentInterface.prompts).toEqual([
      {
        approvalId: "approval:1",
        content: "New notes",
        attemptId: "attempt:primary",
        messageId: "message:1",
        path: "notes.txt",
        summary: "Create notes.txt",
      },
    ]);
    expect(resumed.studentInterface.events).toEqual([
      {
        attemptId: "attempt:primary",
        messageId: "message:1",
        type: "assistant-text",
        text: "I will help. ",
      },
      {
        attemptId: "attempt:primary",
        messageId: "message:1",
        type: "assistant-text",
        text: "Done.",
      },
      { attemptId: "attempt:primary", messageId: "message:1", type: "turn-completed" },
    ]);
    expect(events.find((event) => event.eventType === "assistant-message")).toMatchObject({
      content: "I will help. Done.",
    });
    expect(first.state.state.run?.eventKeys).toEqual([
      "student:message:1",
      "approval:approval:1:requested",
      "approval:approval:1:resolved",
      "approval:approval:1:effect",
      "assistant:message:1",
      JSON.stringify(["message:1", "terminal", "turn-ended"]),
    ]);
  });

  it("retries a response-lost initial open with its persisted new intent and identity", async () => {
    const fixture = createFixtureController();
    fixture.server.loseNextOpenResponse = true;

    await expect(fixture.controller.start("Project One")).rejects.toThrow("open response lost");
    const pending = fixture.state.state.run;
    expect(pending).toMatchObject({ openIntent: { kind: "new" }, phase: "opening" });

    await fixture.controller.start("Project One");

    const [initial, retry] = fixture.server.openRequests;
    expect(retry?.intent).toEqual({ kind: "new" });
    expect(retry?.clientSessionId).toBe(initial?.clientSessionId);
    expect(retry?.idempotencyKey).toBe(initial?.idempotencyKey);
    expect(fixture.state.state.run?.phase).toBe("active");
  });

  it("resumes a bootstrap run by its exact identity without prior local state", async () => {
    const server = new FixtureServer();
    server.active = true;
    const fixture = createFixtureController({ server });

    await fixture.controller.start("Project One");

    expect(server.openRequests).toHaveLength(1);
    expect(server.openRequests[0]).toMatchObject({
      intent: { kind: "resume" },
      runId: "run:1",
    });
    expect(fixture.state.state.run).toMatchObject({
      openIntent: { kind: "resume" },
      phase: "active",
      runId: "run:1",
    });
  });

  it("retries response loss without duplicating a message, event, approval, or effect", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    fixture.server.loseNextAppendResponse = true;

    let responseRejection: TurnAttemptFailed | null = null;
    try {
      await fixture.controller.sendMessage(
        "message:1",
        "Write notes.",
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) responseRejection = error;
    }
    expect(responseRejection?.prefix).toBe("");
    expect(responseRejection?.cause.message).toContain(
      "The Marea model gateway reported a failed stream.",
    );
    expect(fixture.agent.messages).toBe(0);

    await fixture.controller.sendMessage("message:1", "Write notes.", new AbortController().signal);
    await fixture.controller.sendMessage("message:1", "Write notes.", new AbortController().signal);

    expect(fixture.agent.messages).toBe(1);
    expect(fixture.workspace.writes).toBe(1);
    expect([...fixture.server.events.values()].filter(isOriginalActivity)).toHaveLength(6);
    expect(
      [...fixture.server.events.values()].filter((event) => event.eventType === "student-message"),
    ).toHaveLength(1);
  });

  it("recovers a pending approval and effect after restart without replaying the agent", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const originalAppend = fixture.server.appendRunEvents.bind(fixture.server);
    let workspaceResponseLost = true;
    fixture.server.appendRunEvents = async (token, request) => {
      const response = await originalAppend(token, request);
      if (
        workspaceResponseLost &&
        request.events.some((event) => event.eventType === "workspace-edit")
      ) {
        workspaceResponseLost = false;
        throw new ModelStreamError({
          code: "unavailable",
          message: "response lost after workspace effect",
          retryable: true,
        });
      }
      return response;
    };

    const rejection = await captureRejection(
      fixture.controller.sendMessage("message:1", "Write notes.", new AbortController().signal),
    );
    expect(rejection).toBeInstanceOf(TurnAttemptFailed);
    if (rejection instanceof TurnAttemptFailed) {
      expect(rejection.prefix).toBe("I will help. ");
      expect(rejection.cause.message).toBe("The Marea model gateway reported a failed stream.");
    }
    const restarted = createFixtureController({
      agent: fixture.agent,
      credentials: fixture.credentials,
      server: fixture.server,
      state: fixture.state,
      studentInterface: fixture.studentInterface,
      workspace: fixture.workspace,
    });
    await restarted.controller.start("Project One");
    const pending = await restarted.controller.pendingTurn();
    expect(pending).toEqual({
      assistantText: "I will help. ",
      failure: {
        code: "unavailable",
        detail: "response lost after workspace effect",
        hasPrefix: true,
        kind: "provider-interrupted",
        recoverable: true,
        retryable: true,
      },
      messageId: "message:1",
      text: "Write notes.",
    });
    if (pending === null) throw new Error("Pending turn missing.");
    await restarted.controller.sendMessage(
      pending.messageId,
      pending.text,
      new AbortController().signal,
      "attempt:recovered",
    );

    expect(fixture.agent.messages).toBe(1);
    expect(fixture.studentInterface.approvals).toBe(1);
    expect(fixture.workspace.writes).toBe(1);
    expect([...fixture.server.events.values()].filter(isOriginalActivity)).toHaveLength(6);
    expect(await restarted.controller.pendingTurn()).toBeNull();
  });

  it("retries a lost completed-turn delivery without rerunning the agent", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const originalAppend = fixture.server.appendRunEvents.bind(fixture.server);
    let assistantResponseLost = true;
    fixture.server.appendRunEvents = async (token, request) => {
      const response = await originalAppend(token, request);
      if (
        assistantResponseLost &&
        request.events.some((event) => event.eventType === "assistant-message")
      ) {
        assistantResponseLost = false;
        throw new Error("response lost after completed turn");
      }
      return response;
    };

    let completedRejection: TurnAttemptFailed | null = null;
    try {
      await fixture.controller.sendMessage(
        "message:1",
        "Write notes.",
        new AbortController().signal,
        "attempt:initial",
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) completedRejection = error;
    }
    expect(completedRejection?.cause.message).toContain("response lost after completed turn");
    expect(fixture.state.state.run?.turns.at(-1)?.state).toBe("completed");
    expect(fixture.studentInterface.events.at(-1)).not.toMatchObject({
      type: "turn-completed",
    });

    await fixture.controller.sendMessage(
      "message:1",
      "Write notes.",
      new AbortController().signal,
      "attempt:retry",
    );

    expect(fixture.agent.messages).toBe(1);
    expect(fixture.agent.resumes).toBe(1);
    expect(fixture.workspace.writes).toBe(1);
    expect([...fixture.server.events.values()].filter(isOriginalActivity)).toHaveLength(6);
    expect(fixture.state.state.run?.pendingDelivery).toBeNull();
    expect(fixture.studentInterface.events.at(-1)).toEqual({
      attemptId: "attempt:retry",
      messageId: "message:1",
      type: "turn-completed",
    });
  });

  it("retries an idempotent close and requires a fresh controller to reopen", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    fixture.server.loseNextCloseResponse = true;

    await expect(fixture.controller.close()).rejects.toThrow("response lost");
    await fixture.controller.close();
    await fixture.controller.close();
    expect(fixture.server.closeCalls).toBe(2);
    await expect(
      fixture.controller.sendMessage("message:after-close", "No", new AbortController().signal),
    ).rejects.toThrow("session is closing");
    expect(fixture.agent.messages).toBe(0);
    await expect(fixture.controller.start("Project One")).rejects.toThrow("session is closing");
    await restartFixture(fixture);

    expect(fixture.server.closeCalls).toBe(2);
    expect(fixture.server.openRequests).toHaveLength(2);
    expect(fixture.server.openRequests[1]?.intent).toEqual({ kind: "new" });
  });

  it("prompts for login after rejecting a stored credential", async () => {
    const credentials = new MemoryCredentialStore();
    credentials.token = SESSION_TOKEN;
    const server = new FixtureServer();
    server.rejectStored = true;
    const studentInterface = new FixtureInterface();
    studentInterface.authKind = "login";
    const fixture = createFixtureController({ credentials, server, studentInterface });

    await fixture.controller.start("Project One");

    expect(credentials.clears).toBe(1);
    expect(server.loggedIn).toBe(1);
    expect(studentInterface.authenticationReasons).toEqual(["rejected"]);
  });

  it("retains an active run when a turn is cancelled", async () => {
    const agent = new FixtureAgent();
    agent.cancellation = true;
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");

    await fixture.controller.sendMessage("message:cancel", "Stop.", new AbortController().signal);

    expect(fixture.state.state.run?.phase).toBe("active");
    expect(fixture.state.state.run?.turns).toContainEqual({
      messageId: "message:cancel",
      state: "cancelled",
      studentText: "Stop.",
    });
    expect(fixture.studentInterface.events.at(-1)).toMatchObject({
      messageId: "message:cancel",
      type: "turn-cancelled",
    });
    await fixture.controller.sendMessage("message:cancel", "Stop.", new AbortController().signal);
    expect(agent.messages).toBe(1);
  });

  it("treats an aborted runtime failure as cancellation", async () => {
    const agent: FixtureAgent = new FixtureAgent();
    agent.streamMessage = async function* (_turn, signal) {
      signal.throwIfAborted();
      yield { type: "turn-completed" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");
    const abort = new AbortController();
    abort.abort();

    await fixture.controller.sendMessage("message:abort", "Stop.", abort.signal);

    expect(fixture.state.state.run?.turns.at(-1)).toEqual({
      messageId: "message:abort",
      state: "cancelled",
      studentText: "Stop.",
    });
    expect(
      [...fixture.server.events.values()].filter(
        (event) => event.eventType === "assistant-message",
      ),
    ).toEqual([]);
    expect(fixture.studentInterface.events.at(-1)).toMatchObject({
      messageId: "message:abort",
      type: "turn-cancelled",
    });
  });

  it("settles a response-lost close before reopening", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    fixture.server.loseNextCloseResponse = true;
    await expect(fixture.controller.close()).rejects.toThrow("response lost");

    await restartFixture(fixture);

    expect(fixture.server.closeCalls).toBe(2);
    expect(fixture.server.openRequests.at(-1)?.intent).toEqual({ kind: "new" });
  });
});

function isOriginalActivity(event: { readonly eventType: string }): boolean {
  return event.eventType !== "turn-ended" && event.eventType !== "turn-failed";
}
