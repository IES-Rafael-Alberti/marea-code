import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { getHarnessProfile } from "deepagents";
import { describe, expect, it, vi } from "vitest";

import type { AgentEvent, AgentRuntime, ApprovalTool } from "./contracts.js";
import {
  captureAdapterFailure,
  expectPrivateUpstreamFailure,
  approvalReviewId,
  approvalTurn,
  assistantText,
  collect,
  MareaFakeModel,
  MareaStreamingFakeModel,
  pairedToolCall,
  runtimeFor,
  signal,
  unusedTool,
} from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest, resolveCheckpoint } from "./checkpoint.boundary.js";
import { bindTestModel } from "./upstream.boundary.js";

describe("DeepAgents compatibility boundary", () => {
  it("constructs createDeepAgent and translates a v3 text stream", async () => {
    const model = new MareaFakeModel().respond(new AIMessage("hello"));
    const runtime = runtimeFor(model, unusedTool, undefined, "Be concise.");

    await expect(
      collect(
        runtime.streamMessage(
          { messageId: "message:stream", sessionId: "stream-session", text: "hi" },
          signal(),
        ),
      ),
    ).resolves.toEqual([
      { type: "assistant-text-delta", text: "hello" },
      { type: "turn-completed" },
    ]);
    expect(model.callCount).toBe(1);
    expect(model.calls[0]?.messages.some((message) => message.text.includes("Be concise."))).toBe(
      true,
    );
  });

  it("creates tagged opaque model and checkpoint handles", () => {
    const model = bindTestModel(new MareaFakeModel());
    const checkpoint = createInMemoryCheckpointForTest();

    expect(model).toEqual({ kind: "marea-agent-model" });
    expect(checkpoint).toEqual({ kind: "marea-agent-checkpoint" });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(checkpoint)).toBe(true);
  });

  it("disables task and denies every filesystem read and write", async () => {
    const model = new MareaFakeModel()
      .respondWithTools([
        { name: "read_file", id: "read-1", args: { file_path: "/secret" } },
        {
          name: "write_file",
          id: "write-1",
          args: { file_path: "/new", content: "blocked" },
        },
      ])
      .respond(new AIMessage("both blocked"));
    const runtime = runtimeFor(model);

    const events = await collect(
      runtime.streamMessage(
        { messageId: "message:permissions", sessionId: "permission-session", text: "try files" },
        signal(),
      ),
    );
    const secondCall = model.calls[1];
    const results = secondCall?.messages.filter((message) => ToolMessage.isInstance(message)) ?? [];

    expect(events.at(-1)).toEqual({ type: "turn-completed" });
    expect(model.boundToolNames.flat()).not.toContain("task");
    expect(results.map((entry) => entry.content)).toEqual([
      "Error: permission denied for read on /secret",
      "Error: permission denied for write on /new",
    ]);
    const profile = getHarnessProfile("openai:marea");
    expect(profile?.generalPurposeSubagent?.enabled).toBe(false);
    expect(profile?.excludedTools).toEqual(new Set(["task"]));
  });

  it("emits one HITL request, approves it, and resumes its checkpoint", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const execute = vi.fn((arguments_: Readonly<Record<string, string>>) =>
      Promise.resolve(`changed:${arguments_.path ?? ""}`),
    );
    const approvalTool: ApprovalTool = {
      name: "confirm_change",
      description: "Confirm a synthetic change",
      execute,
    };
    const model = new MareaFakeModel().respondWithTools([
      {
        name: "confirm_change",
        id: "change-1",
        args: { path: "src/example.ts" },
      },
    ]);
    const runtime = runtimeFor(model, approvalTool, checkpoint);

    const interrupted = await collect(
      runtime.streamMessage(
        { messageId: "message:approve", sessionId: "approve-session", text: "change it" },
        signal(),
      ),
    );
    expect(interrupted.at(-1)).toMatchObject({
      type: "tool-approval-required",
      toolName: "confirm_change",
      arguments: { path: "src/example.ts" },
      allowedDecisions: ["approve", "amend", "reject"],
    });
    expect(execute).not.toHaveBeenCalled();
    const resumedRuntime = runtimeFor(
      new MareaFakeModel().respond(new AIMessage("approved")),
      approvalTool,
      checkpoint,
    );

    const resumed = await resumeRecoveredApproval(resumedRuntime, "approve-session", interrupted);
    const resumedCall = pairedToolCall(resumed);
    expect(resumed).toMatchObject([
      { type: "tool-approval-submitted", decision: "approve" },
      {
        arguments: { path: "src/example.ts" },
        callId: resumedCall.started,
        name: "confirm_change",
        type: "tool-started",
      },
      {
        callId: resumedCall.finished,
        failed: false,
        result: "changed:src/example.ts",
        type: "tool-finished",
      },
      { type: "assistant-text-delta", text: "approved" },
      { type: "turn-completed" },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ path: "src/example.ts" });
  });

  it("rejects an interrupted tool without executing it", async () => {
    const execute = vi.fn(() => Promise.resolve("must not run"));
    const model = new MareaFakeModel()
      .respondWithTools([
        {
          name: "confirm_change",
          id: "change-2",
          args: { path: "src/rejected.ts" },
        },
      ])
      .respond(new AIMessage("rejected"));
    const runtime = runtimeFor(model, {
      name: "confirm_change",
      description: "Confirm a synthetic change",
      execute,
    });
    const interrupted = await collect(
      runtime.streamMessage(
        { messageId: "message:reject", sessionId: "reject-session", text: "change it" },
        signal(),
      ),
    );

    const events = await collect(
      runtime.resumeApproval(
        {
          ...approvalTurn("reject-session", "message:reject", approvalReviewId(interrupted), {
            type: "reject",
            reason: "Student declined",
          }),
          assistantText: assistantText(interrupted),
        },
        signal(),
      ),
    );
    const rejection = model.calls[1]?.messages.filter((message) => ToolMessage.isInstance(message));

    expect(events).toEqual([
      { type: "tool-approval-submitted", decision: "reject" },
      { type: "assistant-text-delta", text: "rejected" },
      { type: "turn-completed" },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(rejection?.at(-1)?.content).toBe("Student declined");
  });

  it("amends an interrupted tool before executing it", async () => {
    const execute = vi.fn(() => Promise.resolve("amended"));
    const model = new MareaFakeModel()
      .respondWithTools([
        {
          name: "confirm_change",
          id: "change-3",
          args: { path: "src/original.ts" },
        },
      ])
      .respond(new AIMessage("amended"));
    const runtime = runtimeFor(model, {
      name: "confirm_change",
      description: "Confirm a synthetic change",
      execute,
    });
    const interrupted = await collect(
      runtime.streamMessage(
        { messageId: "message:amend", sessionId: "amend-session", text: "change it" },
        signal(),
      ),
    );

    const events = await collect(
      runtime.resumeApproval(
        {
          ...approvalTurn("amend-session", "message:amend", approvalReviewId(interrupted), {
            type: "amend",
            arguments: { path: "src/amended.ts" },
          }),
          assistantText: assistantText(interrupted),
        },
        signal(),
      ),
    );

    const amendedCall = pairedToolCall(events);
    expect(events).toMatchObject([
      { type: "tool-approval-submitted", decision: "amend" },
      {
        arguments: { path: "src/amended.ts" },
        callId: amendedCall.started,
        name: "confirm_change",
        type: "tool-started",
      },
      {
        callId: amendedCall.finished,
        failed: false,
        result: "amended",
        type: "tool-finished",
      },
      { type: "assistant-text-delta", text: "amended" },
      { type: "turn-completed" },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ path: "src/amended.ts" });
  });

  it("cancels an active stream through AbortSignal", async () => {
    const controller = new AbortController();
    const checkpoint = createInMemoryCheckpointForTest();
    const model = new MareaStreamingFakeModel({
      sleep: 5,
      responses: [new AIMessage("streaming")],
    });
    const events: AgentEvent[] = [];

    const runtime = runtimeFor(model, unusedTool, checkpoint);
    for await (const event of runtime.streamMessage(
      { messageId: "message:cancel", sessionId: "cancel-session", text: "start" },
      controller.signal,
    )) {
      events.push(event);
      if (event.type === "assistant-text-delta") {
        controller.abort();
      }
    }

    expect(events[0]).toEqual({ type: "assistant-text-delta", text: "s" });
    expect(events.at(-1)).toEqual({ type: "turn-cancelled" });
    expect(events).not.toContainEqual({ type: "turn-completed" });
    await expect(
      runtime.recoverMessage({
        assistantText: assistantText(events),
        messageId: "message:cancel",
        sessionId: "cancel-session",
      }),
    ).resolves.toEqual({
      type: "cancelled",
      assistantText: "s",
      events: [{ type: "turn-cancelled" }],
    });

    const nextModel = new MareaFakeModel().respond(new AIMessage("fresh"));
    await expect(
      collect(
        runtimeFor(nextModel, unusedTool, checkpoint).streamMessage(
          { messageId: "message:after-cancel", sessionId: "cancel-session", text: "next" },
          signal(),
        ),
      ),
    ).resolves.toEqual([
      { type: "assistant-text-delta", text: "fresh" },
      { type: "turn-completed" },
    ]);
    expect(nextModel.calls[0]?.messages.map((message) => message.text)).not.toContain("start");
  });

  it("persists the pending approval and resumed assistant prefix", async () => {
    const { checkpoint, approvalTool, interrupted } =
      await pendingApprovalFixture("persist-approval");
    expect(resolveCheckpoint(checkpoint)?.findTurn("persist-approval", "message:approve")).toEqual({
      state: "pending-approval",
      events: [
        expect.objectContaining({
          type: "assistant-text-delta",
          text: assistantText(interrupted),
        }),
        expect.objectContaining({
          type: "tool-approval-required",
          reviewId: approvalReviewId(interrupted),
        }),
      ],
    });

    const controller = new AbortController();
    const secondModel = new MareaFakeModel().respond(new AIMessage("approved"));
    const resumed = runtimeFor(secondModel, approvalTool, checkpoint).resumeApproval(
      {
        ...approvalTurn("persist-approval", "message:approve", approvalReviewId(interrupted)),
        assistantText: assistantText(interrupted),
      },
      controller.signal,
    );
    const resumedEvents: AgentEvent[] = [];
    for await (const event of resumed) {
      resumedEvents.push(event);
      controller.abort();
    }
    expect(resumedEvents.at(-1)).toEqual({ type: "turn-cancelled" });
    expect(resolveCheckpoint(checkpoint)?.findTurn("persist-approval", "message:approve")).toEqual({
      state: "cancelled",
      events: [
        expect.objectContaining({
          type: "assistant-text-delta",
          text: assistantText(interrupted),
        }),
        { type: "tool-approval-submitted", decision: "approve" },
        { type: "turn-cancelled" },
      ],
    });
  });

  it("sanitizes a raw upstream state read failure during approval resume", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const saver = resolveCheckpoint(checkpoint);
    if (saver === undefined) throw new Error("Expected an in-memory saver.");
    vi.spyOn(saver, "getTuple").mockRejectedValue(new Error("private provider diagnostic"));

    const result = await captureAdapterFailure(
      runtimeFor(new MareaFakeModel(), unusedTool, checkpoint).resumeApproval(
        approvalTurn("sanitized-resume", "message:raw-state", "review:raw-state"),
        signal(),
      ),
    );

    expectPrivateUpstreamFailure(result.error);
  });

  it("does not read upstream state twice while resuming a recovered approval", async () => {
    const { checkpoint, execute, approvalTool, interrupted } =
      await pendingApprovalFixture("single-read");
    const saver = resolveCheckpoint(checkpoint);
    if (saver === undefined) throw new Error("Expected an in-memory saver.");
    const realGetTuple = saver.getTuple.bind(saver);
    let getTupleCalls = 0;
    vi.spyOn(saver, "getTuple").mockImplementation(async (config) => {
      getTupleCalls += 1;
      if (getTupleCalls > 4) throw new Error("private state diagnostic");
      return realGetTuple(config);
    });

    const resumedModel = new MareaFakeModel().respond(new AIMessage("approved"));
    const singleRead = await resumeRecoveredApproval(
      runtimeFor(resumedModel, approvalTool, checkpoint),
      "single-read",
      interrupted,
    );
    const singleCall = pairedToolCall(singleRead);
    expect(singleRead).toMatchObject([
      { type: "tool-approval-submitted", decision: "approve" },
      {
        arguments: { path: "src/example.ts" },
        callId: singleCall.started,
        name: "confirm_change",
        type: "tool-started",
      },
      {
        callId: singleCall.finished,
        failed: false,
        result: "changed",
        type: "tool-finished",
      },
      { type: "assistant-text-delta", text: "approved" },
      { type: "turn-completed" },
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reconstructs an agent on a shared checkpoint and continues history", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const firstModel = new MareaFakeModel().respond(new AIMessage("first answer"));
    await collect(
      runtimeFor(firstModel, unusedTool, checkpoint).streamMessage(
        { messageId: "message:first", sessionId: "checkpoint-session", text: "first question" },
        signal(),
      ),
    );

    const secondModel = new MareaFakeModel().respond(new AIMessage("second answer"));
    const events = await collect(
      runtimeFor(secondModel, unusedTool, checkpoint).streamMessage(
        { messageId: "message:second", sessionId: "checkpoint-session", text: "second question" },
        signal(),
      ),
    );
    const history = secondModel.calls[0]?.messages.map((message) => message.text);

    expect(events).toEqual([
      { type: "assistant-text-delta", text: "second answer" },
      { type: "turn-completed" },
    ]);
    expect(history).toEqual([
      "Marea synthetic system prompt.",
      "first question",
      "first answer",
      "second question",
    ]);
  });
});

async function pendingApprovalFixture(sessionId: string) {
  const checkpoint = createInMemoryCheckpointForTest();
  const execute = vi.fn(() => Promise.resolve("changed"));
  const approvalTool: ApprovalTool = { ...unusedTool, execute };
  const model = new MareaFakeModel().respondWithTools([
    { name: approvalTool.name, id: "change-1", args: { path: "src/example.ts" } },
  ]);
  const interrupted = await collect(
    runtimeFor(model, approvalTool, checkpoint).streamMessage(
      { messageId: "message:approve", sessionId, text: "change it" },
      signal(),
    ),
  );
  return { checkpoint, execute, approvalTool, interrupted };
}

function resumeRecoveredApproval(
  runtime: AgentRuntime,
  sessionId: string,
  interrupted: readonly AgentEvent[],
) {
  return collect(
    runtime.resumeApproval(
      {
        ...approvalTurn(sessionId, "message:approve", approvalReviewId(interrupted)),
        assistantText: assistantText(interrupted),
      },
      signal(),
    ),
  );
}
it("resumes a declared effect while rejecting an undeclared effect name", async () => {
  const { createAgentRuntime } = await import("./upstream.boundary.js");
  const model = new MareaFakeModel()
    .respondWithTools([{ name: "reviewed_effect", id: "call:effect", args: { path: "main.ts" } }])
    .respond(new AIMessage("done"));
  const execute = vi.fn().mockResolvedValue("recorded result");
  const runtime = createAgentRuntime({
    model: bindTestModel(model),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: unusedTool,
    effectTools: [{ name: "reviewed_effect", description: "Review effect", execute }],
    systemPrompt: "Teach",
  });
  const events = await collect(
    runtime.streamMessage(
      { sessionId: "effect-session", messageId: "message:effect", text: "Act" },
      signal(),
    ),
  );
  const turn = {
    ...approvalTurn("effect-session", "message:effect", approvalReviewId(events)),
    toolName: "reviewed_effect",
    assistantText: assistantText(events),
  };
  expect(() => runtime.resumeApproval({ ...turn, toolName: "undeclared" }, signal())).toThrow(
    "not available",
  );
  expect(assistantText(await collect(runtime.resumeApproval(turn, signal())))).toBe("done");
  expect(execute).toHaveBeenCalledExactlyOnceWith({ path: "main.ts" });
});
