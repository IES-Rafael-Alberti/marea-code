import { describe, expect, it, vi } from "vitest";

import { type AgentCheckpoint, type AgentModel } from "./contracts.js";
import {
  approvalReviewId,
  approvalTurn,
  assistantText,
  captureAdapterFailure,
  expectPrivateUpstreamFailure,
  collect,
  MareaFakeModel,
  runtimeFor,
  signal,
  unusedTool,
} from "./adapter.fixture.js";
import { bindTestModel, createAgentRuntime } from "./upstream.boundary.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";

describe("adapter runtime guards", () => {
  it("rejects forged opaque runtime handles", () => {
    const model = bindTestModel(new MareaFakeModel());
    const checkpoint = createInMemoryCheckpointForTest();
    const forgedModel = { kind: "marea-agent-model" } as AgentModel;
    const forgedCheckpoint = {
      kind: "marea-agent-checkpoint",
    } as AgentCheckpoint;

    expect(() =>
      createAgentRuntime({
        model: forgedModel,
        checkpoint,
        approvalTool: unusedTool,
        systemPrompt: "Marea synthetic system prompt.",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-runtime-dependency" }));
    expect(() =>
      createAgentRuntime({
        model,
        checkpoint: forgedCheckpoint,
        approvalTool: unusedTool,
        systemPrompt: "Marea synthetic system prompt.",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "invalid-runtime-dependency",
        message: "Use adapter-created model and checkpoint handles.",
      }),
    );
  });

  it.each(["", "-leading", "contains space", "a".repeat(129)])(
    "rejects invalid session id %j before using the checkpoint",
    (sessionId) => {
      const runtime = runtimeFor(new MareaFakeModel());
      expect(() =>
        runtime.streamMessage({ messageId: "message:guard", sessionId, text: "unused" }, signal()),
      ).toThrow(
        expect.objectContaining({
          code: "invalid-session-id",
          message: "The session identifier is invalid.",
        }),
      );
    },
  );

  it("rejects an invalid message id before using the checkpoint", async () => {
    const runtime = runtimeFor(new MareaFakeModel());
    expect(() =>
      runtime.streamMessage(
        { messageId: "contains space", sessionId: "valid-session", text: "unused" },
        signal(),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "invalid-message-id",
        message: "The message identifier is invalid.",
      }),
    );
    await expect(
      runtime.recoverMessage({
        messageId: "contains space",
        sessionId: "valid-session",
      }),
    ).rejects.toMatchObject({ code: "invalid-message-id" });
  });

  it("rejects a resume with no pending approval before submitting it", async () => {
    const result = await captureAdapterFailure(
      runtimeFor(new MareaFakeModel()).resumeApproval(
        approvalTurn("missing-checkpoint", "message:missing", "missing-review"),
        signal(),
      ),
    );

    expect(result.events).toEqual([]);
    expect(result.error).toMatchObject({
      code: "approval-not-pending",
      message: "No tool approval is pending for this session.",
    });
  });

  it("rejects a stale review id without submitting or executing", async () => {
    const execute = vi.fn(() => Promise.resolve("must not run"));
    const model = new MareaFakeModel().respondWithTools([
      {
        name: "confirm_change",
        id: "change-stale",
        args: { path: "src/current.ts" },
      },
    ]);
    const runtime = runtimeFor(model, {
      name: "confirm_change",
      description: "Confirm a synthetic change",
      execute,
    });
    const interrupted = await collect(
      runtime.streamMessage(
        { messageId: "message:stale", sessionId: "stale-session", text: "change it" },
        signal(),
      ),
    );

    const result = await captureAdapterFailure(
      runtime.resumeApproval(
        {
          ...approvalTurn("stale-session", "message:stale", "stale-review"),
          assistantText: assistantText(interrupted),
        },
        signal(),
      ),
    );

    expect(result.events).toEqual([]);
    expect(result.error).toMatchObject({
      code: "approval-review-mismatch",
      message: "The pending tool approval does not match this review.",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a matching review submitted for a different message", async () => {
    const execute = vi.fn(() => Promise.resolve("must not run"));
    const runtime = runtimeFor(
      new MareaFakeModel().respondWithTools([
        {
          name: "confirm_change",
          id: "change-message",
          args: { path: "src/current.ts" },
        },
      ]),
      {
        name: "confirm_change",
        description: "Confirm a synthetic change",
        execute,
      },
    );
    const interrupted = await collect(
      runtime.streamMessage(
        { messageId: "message:original", sessionId: "message-identity", text: "change it" },
        signal(),
      ),
    );

    const result = await captureAdapterFailure(
      runtime.resumeApproval(
        approvalTurn("message-identity", "message:other", approvalReviewId(interrupted)),
        signal(),
      ),
    );

    expect(result.events).toEqual([]);
    expect(result.error).toMatchObject({
      code: "approval-message-mismatch",
      message: "The pending tool approval does not match this message.",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a matching review owned by a different configured tool", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const originalExecute = vi.fn(() => Promise.resolve("must not run"));
    const original = runtimeFor(
      new MareaFakeModel().respondWithTools([
        {
          name: "confirm_change",
          id: "change-owned-by-original",
          args: { path: "src/original.ts" },
        },
      ]),
      {
        name: "confirm_change",
        description: "Confirm a synthetic change",
        execute: originalExecute,
      },
      checkpoint,
    );
    const interrupted = await collect(
      original.streamMessage(
        { messageId: "message:changed-tool", sessionId: "changed-tool", text: "change it" },
        signal(),
      ),
    );
    const replacementExecute = vi.fn(() => Promise.resolve("must not run"));
    const replacement = runtimeFor(
      new MareaFakeModel(),
      {
        name: "other_change",
        description: "A different synthetic change",
        execute: replacementExecute,
      },
      checkpoint,
    );

    const result = await captureAdapterFailure(
      replacement.resumeApproval(
        {
          ...approvalTurn("changed-tool", "message:changed-tool", approvalReviewId(interrupted)),
          assistantText: assistantText(interrupted),
        },
        signal(),
      ),
    );

    expect(result.events).toEqual([]);
    expect(result.error).toMatchObject({ code: "upstream-contract-changed" });
    expect(originalExecute).not.toHaveBeenCalled();
    expect(replacementExecute).not.toHaveBeenCalled();
  });

  it("sanitizes an upstream execution failure", async () => {
    const model = new MareaFakeModel().alwaysThrow(new Error("private provider diagnostic"));
    const result = await captureAdapterFailure(
      runtimeFor(model).streamMessage(
        { messageId: "message:failure", sessionId: "failure-session", text: "fail" },
        signal(),
      ),
    );

    expectPrivateUpstreamFailure(result.error);
  });
});
