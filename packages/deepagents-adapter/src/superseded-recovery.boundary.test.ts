import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { RequestId } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  approvalReviewId,
  captureAdapterFailure,
  collect,
  signal,
  useTemporaryDirectories,
} from "./adapter.fixture.js";
import {
  closeAgentCheckpoint,
  createInMemoryCheckpointForTest,
  createLocalCheckpoint,
  resolveCheckpoint,
} from "./checkpoint.boundary.js";
import type { AgentCheckpoint, ApprovalTool, MareaModelGateway } from "./contracts.js";
import {
  gatewayChunk,
  midStreamInvalidResponse as midStreamFailure,
  publicWriteResponse,
  requestIds,
  ScriptedGateway,
  textResponse,
  type GatewayScript,
} from "./gateway-model.fixture.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

const temporaryRoot = useTemporaryDirectories("marea-superseded-");
const SHOWN = "Primero, revisa el bucle";
const REGENERATED = "Primero, mira la condición del while.";
const SHARED = "Primero, ".length;
const QUESTION = "¿Por qué no para?";

/** A model call that never answers until its turn is cancelled. */
function pendingResponse(): GatewayScript {
  return async function* (request, streamSignal) {
    yield gatewayChunk(request, 0, "started");
    await new Promise((resolve) => {
      streamSignal.addEventListener("abort", resolve, { once: true });
    });
  };
}

function runtimeFor(
  gateway: MareaModelGateway,
  checkpoint: AgentCheckpoint,
  nextRequestId: () => RequestId = requestIds(),
  approvalTool: ApprovalTool = {
    name: "unused_tool",
    description: "Unused synthetic tool.",
    execute: () => Promise.resolve("unused"),
  },
) {
  return createAgentRuntime({
    approvalTool,
    checkpoint,
    model: createMareaGatewayModel({ gateway, nextRequestId }),
    systemPrompt: "Teach clearly.",
  });
}

function turn(sessionId: string, assistantText: string) {
  return { assistantText, messageId: "message:failed", sessionId, text: QUESTION };
}

async function failOnce(runtime: ReturnType<typeof runtimeFor>, sessionId: string) {
  await expect(
    captureAdapterFailure(runtime.streamMessage(turn(sessionId, ""), signal())),
  ).resolves.toMatchObject({ error: { code: "upstream-execution-failed" } });
}

describe("text superseded by a regenerated answer", () => {
  it("accepts a caller that kept the discarded text after the new answer was journaled", async () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    mkdirSync(projectDirectory);
    const storageDirectory = join(root, "runtime-state");
    const gateway = new ScriptedGateway(
      midStreamFailure(SHOWN),
      textResponse(REGENERATED),
      textResponse(REGENERATED),
    );
    const ids = requestIds();
    const first = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const runtime = runtimeFor(gateway, first, ids);
    await failOnce(runtime, "durable");
    const retried = runtime.streamMessage(turn("durable", SHOWN), signal());
    const iterator = retried[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "assistant-text-restarted", discardedLength: SHOWN.length },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "assistant-text-delta", text: REGENERATED },
    });
    // The process stops with the new answer journaled while the caller still holds the old one.
    await iterator.return?.(undefined);
    closeAgentCheckpoint(first);

    const second = createLocalCheckpoint({ projectDirectory, storageDirectory });
    try {
      await expect(
        collect(runtimeFor(gateway, second, ids).streamMessage(turn("durable", SHOWN), signal())),
      ).resolves.toEqual([
        { type: "assistant-text-restarted", discardedLength: SHOWN.length },
        { type: "assistant-text-delta", text: REGENERATED },
        { type: "turn-completed" },
      ]);
    } finally {
      closeAgentCheckpoint(second);
    }
  });

  it("leaves the journal alone when the caller holds nothing to discard", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const saver = resolveCheckpoint(checkpoint);
    if (saver === undefined) throw new Error("Expected an in-memory saver.");
    const gateway = new ScriptedGateway(midStreamFailure(SHOWN), pendingResponse());
    const runtime = runtimeFor(gateway, checkpoint);
    await failOnce(runtime, "untouched");
    const journaled = saver.findTurn("untouched", "message:failed");
    const controller = new AbortController();
    const retried = collect(runtime.streamMessage(turn("untouched", ""), controller.signal));
    await vi.waitFor(() => {
      expect(gateway.requests).toHaveLength(2);
    });
    expect(saver.findTurn("untouched", "message:failed")).toEqual(journaled);
    controller.abort();
    await expect(retried).resolves.toEqual([{ type: "turn-cancelled" }]);
  });

  it("drops only what differs from a completed regeneration for a caller that kept old text", async () => {
    const gateway = new ScriptedGateway(midStreamFailure(SHOWN), textResponse(REGENERATED));
    const runtime = runtimeFor(gateway, createInMemoryCheckpointForTest());
    await failOnce(runtime, "shared");
    await collect(runtime.streamMessage(turn("shared", SHOWN), signal()));
    await expect(collect(runtime.streamMessage(turn("shared", SHOWN), signal()))).resolves.toEqual([
      { type: "assistant-text-restarted", discardedLength: SHOWN.length - SHARED },
      { type: "assistant-text-delta", text: REGENERATED.slice(SHARED) },
      { type: "turn-completed" },
    ]);
  });

  it("tells a resumed approval to drop text the regeneration superseded", async () => {
    const execute = vi.fn(() => Promise.resolve("written"));
    const gateway = new ScriptedGateway(
      midStreamFailure(SHOWN),
      publicWriteResponse(),
      textResponse("Hecho."),
    );
    const runtime = runtimeFor(gateway, createInMemoryCheckpointForTest(), requestIds(), {
      name: "marea_write_file",
      description: "Write approved text content to a student file.",
      execute,
    });
    await failOnce(runtime, "approval");
    const regenerated = await collect(runtime.streamMessage(turn("approval", SHOWN), signal()));
    expect(regenerated[0]).toEqual({
      type: "assistant-text-restarted",
      discardedLength: SHOWN.length,
    });
    const resumed = await collect(
      runtime.resumeApproval(
        {
          assistantText: SHOWN,
          decision: { type: "approve" },
          messageId: "message:failed",
          reviewId: approvalReviewId(regenerated),
          sessionId: "approval",
        },
        signal(),
      ),
    );
    expect(resumed[0]).toEqual({ type: "assistant-text-restarted", discardedLength: SHOWN.length });
    expect(resumed.at(-1)).toEqual({ type: "turn-completed" });
    expect(execute).toHaveBeenCalledOnce();
    // The completed turn still accepts the superseded text from a caller that kept it.
    await expect(
      collect(runtime.streamMessage(turn("approval", SHOWN), signal())),
    ).resolves.toEqual([
      { type: "assistant-text-restarted", discardedLength: SHOWN.length },
      { type: "assistant-text-delta", text: "Hecho." },
      { type: "turn-completed" },
    ]);
  });

  it("journals no text for a resume that has no durable turn", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const saver = resolveCheckpoint(checkpoint);
    if (saver === undefined) throw new Error("Expected an in-memory saver.");
    const runtime = runtimeFor(new ScriptedGateway(), checkpoint);
    const resume = (sessionId: string, resumeSignal: AbortSignal) =>
      collect(
        runtime.resumeApproval(
          {
            decision: { type: "approve" },
            messageId: "message:none",
            reviewId: "review-none",
            sessionId,
          },
          resumeSignal,
        ),
      );
    const aborted = new AbortController();
    aborted.abort();
    await expect(resume("none-cancelled", aborted.signal)).resolves.toEqual([
      { type: "turn-cancelled" },
    ]);
    expect(saver.findTurn("none-cancelled", "message:none")?.events).toEqual([
      { type: "turn-cancelled" },
    ]);
    vi.spyOn(saver, "getTuple").mockRejectedValueOnce(new Error("state unreadable"));
    await expect(resume("none-unreadable", signal())).rejects.toMatchObject({
      code: "upstream-execution-failed",
    });
    expect(saver.findTurn("none-unreadable", "message:none")?.events).toEqual([]);
  });

  it("recovers only the text of a journal that also holds the approval it resumed", async () => {
    const gateway = new ScriptedGateway(publicWriteResponse(), midStreamFailure("partial"));
    const runtime = runtimeFor(gateway, createInMemoryCheckpointForTest(), requestIds(), {
      name: "marea_write_file",
      description: "Write approved text content to a student file.",
      execute: () => Promise.resolve("written"),
    });
    const interrupted = await collect(
      runtime.streamMessage(
        { messageId: "message:write", sessionId: "journal", text: "save" },
        signal(),
      ),
    );
    await captureAdapterFailure(
      runtime.resumeApproval(
        {
          assistantText: "",
          decision: { type: "approve" },
          messageId: "message:write",
          reviewId: approvalReviewId(interrupted),
          sessionId: "journal",
        },
        signal(),
      ),
    );
    await expect(
      runtime.recoverMessage({
        assistantText: "",
        messageId: "message:write",
        sessionId: "journal",
      }),
    ).resolves.toEqual({
      type: "in-progress",
      assistantText: "partial",
      events: [{ type: "assistant-text-delta", text: "partial" }],
    });
  });

  it("ends a cancelled turn again instead of running it", async () => {
    const gateway = new ScriptedGateway(pendingResponse());
    const runtime = runtimeFor(gateway, createInMemoryCheckpointForTest());
    const controller = new AbortController();
    const first = collect(runtime.streamMessage(turn("cancelled", ""), controller.signal));
    await vi.waitFor(() => {
      expect(gateway.requests).toHaveLength(1);
    });
    controller.abort();
    await expect(first).resolves.toEqual([{ type: "turn-cancelled" }]);
    await expect(collect(runtime.streamMessage(turn("cancelled", ""), signal()))).resolves.toEqual([
      { type: "turn-cancelled" },
    ]);
    expect(gateway.requests).toHaveLength(1);
  });
});
