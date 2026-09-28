import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { RequestId } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  approvalReviewId,
  approvedWriteEvents,
  assistantText,
  captureAdapterFailure,
  collect,
  pairedToolCall,
  signal,
  useTemporaryDirectories,
} from "./adapter.fixture.js";
import {
  closeAgentCheckpoint,
  createInMemoryCheckpointForTest,
  createLocalCheckpoint,
  resolveCheckpoint,
} from "./checkpoint.boundary.js";
import type {
  AgentCheckpoint,
  AgentRuntime,
  ApprovalTool,
  MareaModelGateway,
} from "./contracts.js";
import {
  partialTextFailureResponse,
  partialWriteFailureResponse,
  publicWriteResponse,
  requestIds,
  ScriptedGateway,
  textResponse,
} from "./gateway-model.fixture.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

const temporaryRoot = useTemporaryDirectories("marea-failed-turn-");
const controlledWrite = {
  name: "marea_write_file",
  description: "Write approved text content to a student file.",
};

describe("failed DeepAgents turn recovery", () => {
  it("replays partial provider text on the same message after a durable restart", async () => {
    const gateway = new ScriptedGateway(
      textResponse("prior answer"),
      partialTextFailureResponse(),
      textResponse("partial recovered"),
    );
    const ids = requestIds();
    const { projectDirectory, storageDirectory } = durableDirectories();
    const firstCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const firstRuntime = runtime(gateway, firstCheckpoint, ids);
    await collect(
      firstRuntime.streamMessage(
        { messageId: "message:prior", sessionId: "partial-retry", text: "first" },
        signal(),
      ),
    );
    const failed = await captureAdapterFailure(
      firstRuntime.streamMessage(
        { messageId: "message:failed", sessionId: "partial-retry", text: "failed" },
        signal(),
      ),
    );
    expect(failed).toMatchObject({
      events: [{ type: "assistant-text-delta", text: "partial" }],
      error: { code: "upstream-execution-failed" },
    });
    closeAgentCheckpoint(firstCheckpoint);

    const secondCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    try {
      const restarted = runtime(gateway, secondCheckpoint, ids);
      await expect(
        restarted.recoverMessage({
          assistantText: "partial",
          messageId: "message:failed",
          sessionId: "partial-retry",
        }),
      ).resolves.toMatchObject({ type: "in-progress", assistantText: "partial", events: [] });
      await expect(
        collect(
          restarted.streamMessage(
            {
              assistantText: "par",
              messageId: "message:failed",
              sessionId: "partial-retry",
              text: "failed",
            },
            signal(),
          ),
        ),
      ).resolves.toEqual([
        { type: "assistant-text-delta", text: "tial" },
        { type: "assistant-text-delta", text: " recovered" },
        { type: "turn-completed" },
      ]);
    } finally {
      closeAgentCheckpoint(secondCheckpoint);
    }
    expect(studentMessages(gateway, 2)).toEqual(["first", "failed"]);
  });

  it("continues after a post-write provider failure without executing the tool twice", async () => {
    const gateway = new ScriptedGateway(
      publicWriteResponse(),
      partialTextFailureResponse(),
      textResponse("partial saved"),
    );
    const execute = vi.fn(() => Promise.resolve("the original durable effect"));
    const ids = requestIds();
    const { projectDirectory, storageDirectory } = durableDirectories();
    const firstCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const firstRuntime = runtime(gateway, firstCheckpoint, ids, { ...controlledWrite, execute });
    const interrupted = await collect(
      firstRuntime.streamMessage(
        { messageId: "message:write", sessionId: "post-write", text: "save" },
        signal(),
      ),
    );
    const reviewId = approvalReviewId(interrupted);
    const initialText = assistantText(interrupted);
    const failed = await captureAdapterFailure(
      firstRuntime.resumeApproval(
        {
          assistantText: initialText,
          decision: { type: "approve" },
          messageId: "message:write",
          reviewId,
          sessionId: "post-write",
        },
        signal(),
      ),
    );
    expect(failed).toMatchObject({
      events: [
        ...approvedWriteEvents(failed.events, "the original durable effect"),
        { type: "assistant-text-delta", text: "partial" },
      ],
      error: { code: "upstream-execution-failed" },
    });
    expect(execute).toHaveBeenCalledOnce();
    closeAgentCheckpoint(firstCheckpoint);

    const secondCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    try {
      const restarted = runtime(gateway, secondCheckpoint, ids, { ...controlledWrite, execute });
      await expect(
        collect(
          restarted.resumeApproval(
            {
              assistantText: `${initialText}partial`,
              decision: { type: "approve" },
              messageId: "message:write",
              reviewId,
              sessionId: "post-write",
            },
            signal(),
          ),
        ),
      ).resolves.toEqual([
        { type: "assistant-text-delta", text: " saved" },
        { type: "turn-completed" },
      ]);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      closeAgentCheckpoint(secondCheckpoint);
    }
  });

  it("retains the original review while retrying a tool node that failed before completion", async () => {
    const gateway = new ScriptedGateway(publicWriteResponse(), textResponse("saved"));
    let completedWrappers = 0;
    const execute = vi.fn<ApprovalTool["execute"]>(() => {
      if (execute.mock.calls.length === 1) return new Promise(() => undefined);
      completedWrappers += 1;
      return Promise.resolve("the original durable effect");
    });
    const ids = requestIds();
    const { projectDirectory, storageDirectory } = durableDirectories();
    const firstCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const firstSaver = resolveCheckpoint(firstCheckpoint);
    if (firstSaver === undefined) throw new Error("Expected a durable saver.");
    vi.spyOn(firstSaver, "recordTurn").mockRejectedValueOnce(new Error("journal unavailable"));
    const firstRuntime = runtime(gateway, firstCheckpoint, ids, { ...controlledWrite, execute });
    await expect(
      captureAdapterFailure(
        firstRuntime.streamMessage(
          { messageId: "message:tool", sessionId: "tool-retry", text: "save" },
          signal(),
        ),
      ),
    ).resolves.toMatchObject({ error: { code: "upstream-execution-failed" } });
    closeAgentCheckpoint(firstCheckpoint);

    const resumedCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const resumedRuntime = runtime(gateway, resumedCheckpoint, ids, {
      ...controlledWrite,
      execute,
    });
    const interrupted = await collect(
      resumedRuntime.streamMessage(
        { messageId: "message:tool", sessionId: "tool-retry", text: "save" },
        signal(),
      ),
    );
    const reviewId = approvalReviewId(interrupted);
    expect(
      resolveCheckpoint(resumedCheckpoint)?.findTurn("tool-retry", "message:tool"),
    ).toMatchObject({ state: "pending-approval" });
    const resumedApproval = resumedRuntime.resumeApproval(
      {
        decision: { type: "approve" },
        messageId: "message:tool",
        reviewId,
        sessionId: "tool-retry",
      },
      signal(),
    );
    const abandoned = resumedApproval[Symbol.asyncIterator]();
    await expect(abandoned.next()).resolves.toEqual({
      done: false,
      value: { type: "tool-approval-submitted", decision: "approve" },
    });
    void abandoned.next();
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(completedWrappers).toBe(0);
    closeAgentCheckpoint(resumedCheckpoint);

    const finalCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    try {
      const restarted = runtime(gateway, finalCheckpoint, ids, { ...controlledWrite, execute });
      await expect(
        collect(
          restarted.resumeApproval(
            {
              decision: { type: "approve" },
              messageId: "message:tool",
              reviewId: "different-review",
              sessionId: "tool-retry",
            },
            signal(),
          ),
        ),
      ).rejects.toMatchObject({ code: "approval-review-mismatch" });
      expect(execute).toHaveBeenCalledOnce();
      const resumed = await collect(
        restarted.resumeApproval(
          {
            decision: { type: "approve" },
            messageId: "message:tool",
            reviewId,
            sessionId: "tool-retry",
          },
          signal(),
        ),
      );
      const resumedCall = pairedToolCall(resumed);
      expect(resumed).toMatchObject([
        {
          arguments: { content: "hello", path: "notes.txt" },
          callId: resumedCall.started,
          name: "marea_write_file",
          type: "tool-started",
        },
        {
          callId: resumedCall.finished,
          failed: false,
          result: "the original durable effect",
          type: "tool-finished",
        },
        { type: "assistant-text-delta", text: "saved" },
        { type: "turn-completed" },
      ]);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(completedWrappers).toBe(1);
    } finally {
      closeAgentCheckpoint(finalCheckpoint);
    }
  });

  it("branches a distinct message from the last completed head", async () => {
    const gateway = new ScriptedGateway(
      textResponse("prior answer"),
      partialWriteFailureResponse(),
      textResponse("fresh answer"),
    );
    const { execute, runtimeValue } = controlledRuntime(gateway);
    await collect(
      runtimeValue.streamMessage(
        { messageId: "message:prior", sessionId: "provider-recovery", text: "first" },
        signal(),
      ),
    );
    await expectFailedMessage(runtimeValue, "provider-recovery", "message:failed");
    await expectFreshMessage(runtimeValue, "provider-recovery");
    expect(execute).not.toHaveBeenCalled();
    expect(studentMessages(gateway, 2)).toEqual(["first", "after"]);
    expect(gateway.requests[2]?.messages).toContainEqual({
      role: "assistant",
      content: "prior answer",
      toolCalls: [],
    });
  });

  it("starts a distinct message cleanly when the first turn failed", async () => {
    const gateway = new ScriptedGateway(
      partialWriteFailureResponse(),
      textResponse("fresh answer"),
    );
    const { execute, runtimeValue } = controlledRuntime(gateway);

    await expectFailedMessage(runtimeValue, "no-safe-head", "message:failed-first");
    await expectFreshMessage(runtimeValue, "no-safe-head");

    expect(execute).not.toHaveBeenCalled();
    expect(gateway.requests[1]?.messages.filter((message) => message.role !== "system")).toEqual([
      { role: "student", content: "after" },
    ]);
  });

  it("rejects persisted text for a message without durable state", async () => {
    const gateway = new ScriptedGateway();
    const runtimeValue = runtime(gateway, createInMemoryCheckpointForTest(), requestIds());

    await expect(
      collect(
        runtimeValue.streamMessage(
          {
            assistantText: "orphaned",
            messageId: "message:missing",
            sessionId: "missing-state",
            text: "question",
          },
          signal(),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid-replay-prefix" });
    expect(gateway.requests).toEqual([]);
  });
});

function durableDirectories(): {
  readonly projectDirectory: string;
  readonly storageDirectory: string;
} {
  const root = temporaryRoot();
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  return { projectDirectory, storageDirectory: join(root, "runtime-state") };
}

function runtime(
  gateway: MareaModelGateway,
  checkpoint: AgentCheckpoint,
  nextRequestId: () => RequestId,
  approvalTool: ApprovalTool = {
    name: "unused_tool",
    description: "Unused synthetic tool.",
    execute: () => Promise.resolve("unused"),
  },
): AgentRuntime {
  return createAgentRuntime({
    approvalTool,
    checkpoint,
    model: createMareaGatewayModel({ gateway, nextRequestId }),
    systemPrompt: "Teach clearly.",
  });
}

function studentMessages(gateway: ScriptedGateway, requestIndex: number): readonly string[] {
  return (
    gateway.requests[requestIndex]?.messages
      .filter((message) => message.role === "student")
      .map((message) => message.content) ?? []
  );
}

function controlledRuntime(gateway: ScriptedGateway) {
  const execute = vi.fn(() => Promise.resolve("must not execute"));
  const runtimeValue = runtime(gateway, createInMemoryCheckpointForTest(), requestIds(), {
    ...controlledWrite,
    execute,
  });
  return { execute, runtimeValue };
}

async function expectFailedMessage(
  runtimeValue: AgentRuntime,
  sessionId: string,
  messageId: string,
): Promise<void> {
  await expect(
    collect(runtimeValue.streamMessage({ messageId, sessionId, text: "failed" }, signal())),
  ).rejects.toMatchObject({ code: "upstream-execution-failed" });
}

async function expectFreshMessage(runtimeValue: AgentRuntime, sessionId: string): Promise<void> {
  await expect(
    collect(
      runtimeValue.streamMessage(
        { messageId: "message:fresh", sessionId, text: "after" },
        signal(),
      ),
    ),
  ).resolves.toEqual([
    { type: "assistant-text-delta", text: "fresh answer" },
    { type: "turn-completed" },
  ]);
}
