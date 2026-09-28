import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import {
  approvalReviewId,
  approvalTurn,
  assistantText,
  captureAdapterFailure,
  collect,
  MareaFakeModel,
  pairedToolCall,
  runtimeFor,
  signal,
  unusedTool,
  useTemporaryDirectories,
} from "./adapter.fixture.js";
import {
  closeAgentCheckpoint,
  createInMemoryCheckpointForTest,
  createLocalCheckpoint,
  resolveCheckpoint,
} from "./checkpoint.boundary.js";
import { AgentAdapterError } from "./contracts.js";

const temporaryRoot = useTemporaryDirectories("marea-recovery-");

describe("agent turn recovery", () => {
  it("recovers completed turns and pending approvals after checkpoint reopen", async () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    const storageDirectory = join(root, "state", "agent");
    mkdirSync(projectDirectory);

    const firstCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const firstModel = new MareaFakeModel().respond(new AIMessage("completed answer"));
    await expectCompleted(
      runtimeFor(firstModel, unusedTool, firstCheckpoint).streamMessage(
        { messageId: "message:completed", sessionId: "restart-session", text: "first" },
        signal(),
      ),
      "completed answer",
    );
    closeAgentCheckpoint(firstCheckpoint);

    const completedModel = new MareaFakeModel().respond(new AIMessage("must not be requested"));
    const secondCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const completedRuntime = runtimeFor(completedModel, unusedTool, secondCheckpoint);
    await expect(
      completedRuntime.recoverMessage({
        messageId: "message:completed",
        sessionId: "restart-session",
      }),
    ).resolves.toMatchObject({ type: "completed", assistantText: "completed answer" });
    await expect(
      completedRuntime.recoverMessage({
        messageId: "message:missing",
        sessionId: "restart-session",
      }),
    ).resolves.toBeNull();
    await expectCompleted(
      completedRuntime.streamMessage(
        { messageId: "message:completed", sessionId: "restart-session", text: "first" },
        signal(),
      ),
      "completed answer",
    );
    expect(completedModel.callCount).toBe(0);
    const metadata = [];
    for await (const tuple of resolveCheckpoint(secondCheckpoint)?.list({
      configurable: { thread_id: "restart-session" },
    }) ?? []) {
      metadata.push(tuple.metadata);
    }
    expect(metadata).toContainEqual(expect.objectContaining({ messageId: "message:completed" }));
    closeAgentCheckpoint(secondCheckpoint);

    const approvalExecute = vi.fn(() => Promise.resolve("approved result"));
    const approvalTool = {
      name: "marea_write_file",
      description: "Approve a synthetic write.",
      execute: approvalExecute,
    };
    const approvalModel = new MareaFakeModel().respond(
      new AIMessage({
        content: "review first",
        tool_calls: [
          {
            name: "marea_write_file",
            id: "write-1",
            args: { path: "notes.txt", content: "hello" },
            type: "tool_call",
          },
        ],
      }),
    );
    const approvalCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const interrupted = await collect(
      runtimeFor(approvalModel, approvalTool, approvalCheckpoint).streamMessage(
        { messageId: "message:approval", sessionId: "approval-session", text: "write" },
        signal(),
      ),
    );
    const reviewId = approvalReviewId(interrupted);
    closeAgentCheckpoint(approvalCheckpoint);

    const recoveredModel = new MareaFakeModel().respond(new AIMessage("approved"));
    const reopenedApprovalCheckpoint = createLocalCheckpoint({
      projectDirectory,
      storageDirectory,
    });
    const recoveredRuntime = runtimeFor(recoveredModel, approvalTool, reopenedApprovalCheckpoint);
    await expect(
      recoveredRuntime.recoverMessage({
        messageId: "message:approval",
        sessionId: "approval-session",
      }),
    ).resolves.toMatchObject({ type: "pending-approval" });
    const recovered = await collect(
      recoveredRuntime.streamMessage(
        {
          assistantText: assistantText(interrupted),
          messageId: "message:approval",
          sessionId: "approval-session",
          text: "write",
        },
        signal(),
      ),
    );
    expect(recovered).toEqual([
      expect.objectContaining({
        type: "tool-approval-required",
        reviewId,
        toolName: "marea_write_file",
      }),
    ]);
    expect(recoveredModel.callCount).toBe(0);
    const resumed = await collect(
      recoveredRuntime.resumeApproval(
        {
          ...approvalTurn("approval-session", "message:approval", reviewId),
          assistantText: "review ",
        },
        signal(),
      ),
    );
    const resumedCall = pairedToolCall(resumed);
    expect(resumed).toMatchObject([
      { type: "assistant-text-delta", text: "first" },
      { type: "tool-approval-submitted", decision: "approve" },

      {
        arguments: { content: "hello", path: "notes.txt" },
        callId: resumedCall.started,
        name: "marea_write_file",
        type: "tool-started",
      },
      {
        callId: resumedCall.finished,
        failed: false,
        result: "approved result",
        type: "tool-finished",
      },
      { type: "assistant-text-delta", text: "approved" },
      { type: "turn-completed" },
    ]);
    expect(approvalExecute).toHaveBeenCalledOnce();
    closeAgentCheckpoint(reopenedApprovalCheckpoint);

    const completedApprovalCheckpoint = createLocalCheckpoint({
      projectDirectory,
      storageDirectory,
    });
    const completedApprovalRuntime = runtimeFor(
      new MareaFakeModel().respond(new AIMessage("must not be requested")),
      approvalTool,
      completedApprovalCheckpoint,
    );
    await expect(
      completedApprovalRuntime.recoverMessage({
        messageId: "message:approval",
        sessionId: "approval-session",
      }),
    ).resolves.toMatchObject({
      type: "completed",
      assistantText: `${assistantText(interrupted)}approved`,
    });
    closeAgentCheckpoint(completedApprovalCheckpoint);
  });

  it.each(["completed", "pending-approval"] as const)(
    "reconstructs a %s turn when the graph is durable before the turn journal",
    async (expectedState) => {
      const checkpoint = createInMemoryCheckpointForTest();
      const saver = resolveCheckpoint(checkpoint);
      if (saver === undefined) throw new Error("Expected an in-memory saver.");
      const originalRecord = saver.recordTurn.bind(saver);
      let failTerminal = true;
      vi.spyOn(saver, "recordTurn").mockImplementation((session, message, record) => {
        if (failTerminal && record.state === expectedState) {
          failTerminal = false;
          return Promise.reject(new Error("journal unavailable"));
        }
        return originalRecord(session, message, record);
      });
      const model =
        expectedState === "completed"
          ? new MareaFakeModel().respond(new AIMessage("durable answer"))
          : new MareaFakeModel().respondWithTools([
              {
                name: "confirm_change",
                id: "durable-tool",
                args: { path: "notes.txt" },
              },
            ]);
      const messageId = `message:${expectedState}`;
      const sessionId = `journal-gap-${expectedState}`;

      const failed = await captureAdapterFailure(
        runtimeFor(model, unusedTool, checkpoint).streamMessage(
          { messageId, sessionId, text: "question" },
          signal(),
        ),
      );
      expect(failed.error).toMatchObject({ code: "upstream-execution-failed" });
      const restartedModel = new MareaFakeModel().respond(new AIMessage("fresh answer"));
      const restarted = runtimeFor(restartedModel, unusedTool, checkpoint);
      const recovered = await restarted.recoverMessage({ messageId, sessionId });

      expect(recovered).toMatchObject({ type: expectedState });
      expect(restartedModel.callCount).toBe(0);
      const latest = await saver.getTuple({ configurable: { thread_id: sessionId } });
      const messages = latest?.checkpoint.channel_values.messages;
      expect(
        Array.isArray(messages) &&
          messages.some((message) => HumanMessage.isInstance(message) && message.id === messageId),
      ).toBe(true);
      const replayed = await collect(
        restarted.streamMessage(
          {
            assistantText: recovered?.assistantText ?? "",
            messageId,
            sessionId,
            text: "question",
          },
          signal(),
        ),
      );
      expect(replayed.at(-1)?.type).toBe(
        expectedState === "completed" ? "turn-completed" : "tool-approval-required",
      );
      expect(replayed).not.toContainEqual(
        expect.objectContaining({ type: "assistant-text-delta" }),
      );
      if (expectedState === "completed") {
        await expect(
          collect(
            restarted.streamMessage(
              { messageId: "message:fresh", sessionId, text: "after" },
              signal(),
            ),
          ),
        ).resolves.toEqual([
          { type: "assistant-text-delta", text: "fresh answer" },
          { type: "turn-completed" },
        ]);
        const history = restartedModel.calls[0]?.messages ?? [];
        expect(
          history
            .filter((message) => HumanMessage.isInstance(message))
            .map((message) => message.text),
        ).toEqual(["question", "after"]);
        expect(
          history.some(
            (message) => AIMessage.isInstance(message) && message.text === "durable answer",
          ),
        ).toBe(true);
      }
    },
  );

  it("continues an in-progress graph checkpoint without appending the user message twice", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const saver = resolveCheckpoint(checkpoint);
    if (saver === undefined) throw new Error("Expected an in-memory saver.");
    const originalPut = saver.put.bind(saver);
    let interrupted = false;
    vi.spyOn(saver, "put").mockImplementation(async (...arguments_) => {
      const saved = await originalPut(...arguments_);
      const metadata = arguments_[2];
      if (!interrupted && metadata.step === 1) {
        interrupted = true;
        throw new AgentAdapterError(
          "invalid-checkpoint-state",
          "Synthetic process stop after graph write.",
        );
      }
      return saved;
    });
    const firstModel = new MareaFakeModel().respond(new AIMessage("prefix "));
    const first = await captureAdapterFailure(
      runtimeFor(firstModel, unusedTool, checkpoint).streamMessage(
        { messageId: "message:graph-write", sessionId: "graph-write", text: "once" },
        signal(),
      ),
    );
    expect(first.error).toMatchObject({ code: "invalid-checkpoint-state" });
    expect(firstModel.callCount).toBe(1);

    const resumedModel = new MareaFakeModel().respond(new AIMessage("prefix continued"));
    const resumed = runtimeFor(resumedModel, unusedTool, checkpoint);
    const findSessionHead = vi.spyOn(saver, "findSessionHead");
    await expect(
      resumed.recoverMessage({ messageId: "message:graph-write", sessionId: "graph-write" }),
    ).resolves.toMatchObject({ type: "in-progress", assistantText: "prefix " });
    await expect(
      collect(
        resumed.streamMessage(
          {
            messageId: "message:graph-write",
            sessionId: "graph-write",
            text: "once",
            assistantText: assistantText(first.events),
          },
          signal(),
        ),
      ),
    ).resolves.toEqual([
      { type: "assistant-text-delta", text: "continued" },
      { type: "turn-completed" },
    ]);
    const humans = resumedModel.calls[0]?.messages.filter((message) =>
      HumanMessage.isInstance(message),
    );
    expect(humans).toHaveLength(1);
    expect(humans?.[0]).toMatchObject({ id: "message:graph-write", content: "once" });
    expect(findSessionHead).not.toHaveBeenCalled();
  });

  it("does not repeat an approved tool after graph completion outlives journal persistence", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const saver = resolveCheckpoint(checkpoint);
    if (saver === undefined) throw new Error("Expected an in-memory saver.");
    const execute = vi.fn(() => Promise.resolve("written"));
    const tool = {
      name: "confirm_change",
      description: "Confirm a change.",
      execute,
    };
    const interrupted = await collect(
      runtimeFor(
        new MareaFakeModel().respondWithTools([
          { name: "confirm_change", id: "once-tool", args: { path: "notes.txt" } },
        ]),
        tool,
        checkpoint,
      ).streamMessage(
        { messageId: "message:tool-once", sessionId: "tool-once", text: "write" },
        signal(),
      ),
    );
    const originalRecordTurn = saver.recordTurn.bind(saver);
    let failCompleted = true;
    vi.spyOn(saver, "recordTurn").mockImplementation((session, message, record) => {
      if (failCompleted && record.state === "completed") {
        failCompleted = false;
        return Promise.reject(new Error("journal unavailable"));
      }
      return originalRecordTurn(session, message, record);
    });
    const resumed = runtimeFor(
      new MareaFakeModel().respond(new AIMessage("finished")),
      tool,
      checkpoint,
    );
    const failed = await captureAdapterFailure(
      resumed.resumeApproval(
        {
          ...approvalTurn("tool-once", "message:tool-once", approvalReviewId(interrupted)),
          assistantText: assistantText(interrupted),
        },
        signal(),
      ),
    );
    expect(failed.error).toMatchObject({ code: "upstream-execution-failed" });
    expect(execute).toHaveBeenCalledOnce();
    const persistedText = assistantText(interrupted) + assistantText(failed.events);

    const retryModel = new MareaFakeModel().respond(new AIMessage("must not run"));
    await expect(
      collect(
        runtimeFor(retryModel, tool, checkpoint).resumeApproval(
          {
            ...approvalTurn("tool-once", "message:tool-once", approvalReviewId(interrupted)),
            assistantText: persistedText,
          },
          signal(),
        ),
      ),
    ).resolves.toEqual([{ type: "turn-completed" }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(retryModel.callCount).toBe(0);
  });

  it("replays only after an exact persisted text prefix", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const runtime = runtimeFor(
      new MareaFakeModel().respond(new AIMessage("same-length-safe")),
      unusedTool,
      checkpoint,
    );
    await collect(
      runtime.streamMessage(
        { messageId: "message:prefix", sessionId: "prefix", text: "question" },
        signal(),
      ),
    );

    await expect(
      runtime.recoverMessage({
        assistantText: "same-length",
        messageId: "message:prefix",
        sessionId: "prefix",
      }),
    ).resolves.toEqual({
      type: "completed",
      assistantText: "same-length-safe",
      events: [{ type: "assistant-text-delta", text: "-safe" }, { type: "turn-completed" }],
    });
    await expect(
      runtime.recoverMessage({
        assistantText: "wrong-length",
        messageId: "message:prefix",
        sessionId: "prefix",
      }),
    ).rejects.toMatchObject({ code: "invalid-replay-prefix" });
  });

  it("replays a cancelled approval turn without resuming it", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const saver = resolveCheckpoint(checkpoint);
    if (saver === undefined) throw new Error("Expected an in-memory saver.");
    await saver.recordTurn("cancelled-approval", "message:cancelled-approval", {
      state: "cancelled",
      events: [{ type: "assistant-text-delta", text: "stopped" }, { type: "turn-cancelled" }],
    });
    const model = new MareaFakeModel().respond(new AIMessage("must not run"));

    await expect(
      collect(
        runtimeFor(model, unusedTool, checkpoint).resumeApproval(
          {
            assistantText: "stop",
            decision: { type: "approve" },
            messageId: "message:cancelled-approval",
            reviewId: "review:already-cancelled",
            sessionId: "cancelled-approval",
          },
          signal(),
        ),
      ),
    ).resolves.toEqual([{ type: "assistant-text-delta", text: "ped" }, { type: "turn-cancelled" }]);
    expect(model.callCount).toBe(0);
  });
});

async function expectCompleted(
  events: AsyncIterable<import("./contracts.js").AgentEvent>,
  text: string,
): Promise<void> {
  await expect(collect(events)).resolves.toEqual([
    { type: "assistant-text-delta", text },
    { type: "turn-completed" },
  ]);
}
