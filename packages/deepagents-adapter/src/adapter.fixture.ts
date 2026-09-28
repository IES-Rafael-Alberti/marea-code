import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBuiltModel } from "@langchain/core/testing";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { afterEach, expect, vi } from "vitest";

import {
  AgentAdapterError,
  type AgentEvent,
  type AgentRuntime,
  type ApprovalTool,
  type ApprovalTurn,
} from "./contracts.js";
import { bindTestModel, createAgentRuntime, diagnosticCauseFor } from "./upstream.boundary.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";

export { AIMessage, ToolMessage } from "@langchain/core/messages";

export class MareaFakeModel extends FakeBuiltModel {
  readonly modelName = "marea";
  readonly boundToolNames: string[][] = [];

  override getName(): string {
    return "ChatOpenAI";
  }

  override bindTools(tools: Parameters<FakeBuiltModel["bindTools"]>[0]) {
    this.boundToolNames.push(tools.map((entry) => entry.name));
    return super.bindTools(tools);
  }
}

export class MareaStreamingFakeModel extends FakeStreamingChatModel {
  readonly modelName = "marea";

  override getName(): string {
    return "ChatOpenAI";
  }
}

export const unusedTool: ApprovalTool = {
  name: "confirm_change",
  description: "Confirm a synthetic change",
  execute: vi.fn(() => Promise.resolve("changed")),
};

export function runtimeFor(
  model: MareaFakeModel | MareaStreamingFakeModel,
  approvalTool: ApprovalTool = unusedTool,
  checkpoint = createInMemoryCheckpointForTest(),
  systemPrompt = "Marea synthetic system prompt.",
): AgentRuntime {
  return createAgentRuntime({
    model: bindTestModel(model),
    checkpoint,
    approvalTool,
    systemPrompt,
  });
}

export async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export async function captureAdapterFailure(stream: AsyncIterable<AgentEvent>): Promise<{
  readonly events: AgentEvent[];
  readonly error: AgentAdapterError | null;
}> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
    return { events, error: null };
  } catch (error) {
    if (!(error instanceof AgentAdapterError)) throw error;
    return { events, error };
  }
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}

export function expectPrivateUpstreamFailure(error: AgentAdapterError | null): void {
  expect(error).toMatchObject({
    name: "AgentAdapterError",
    code: "upstream-execution-failed",
    message: "The agent runtime failed without exposing provider diagnostics.",
  });
  expect(error === null ? null : diagnosticCauseFor(error)).toEqual({
    name: "Error",
    message: "private provider diagnostic",
  });
  expect(JSON.stringify(error)).not.toContain("private provider diagnostic");
}

export function approvalReviewId(events: readonly AgentEvent[]): string {
  const approval = events.find((event) => event.type === "tool-approval-required");
  if (approval === undefined) {
    throw new Error("Expected a tool approval event.");
  }
  return approval.reviewId;
}

/** The paired call ids of one tool execution, asserting they match and name a call. */
export function pairedToolCall(events: readonly AgentEvent[]): {
  readonly finished: string;
  readonly started: string;
} {
  const started = events.find((event) => event.type === "tool-started");
  const finished = events.find((event) => event.type === "tool-finished");
  if (started?.type !== "tool-started" || finished?.type !== "tool-finished") {
    throw new Error("Expected paired tool call events.");
  }
  expect(started.callId).toBe(finished.callId);
  expect(started.callId.length).toBeGreaterThan(0);
  return { finished: finished.callId, started: started.callId };
}

export function approvedWriteEvents(events: readonly AgentEvent[], result: string): AgentEvent[] {
  const call = pairedToolCall(events);
  return [
    { type: "tool-approval-submitted", decision: "approve" },
    {
      arguments: { content: "hello", path: "notes.txt" },
      callId: call.started,
      name: "marea_write_file",
      type: "tool-started",
    },
    { callId: call.finished, failed: false, result, type: "tool-finished" },
  ];
}

export function assistantText(events: readonly AgentEvent[]): string {
  return events
    .filter(
      (event): event is Extract<AgentEvent, { readonly type: "assistant-text-delta" }> =>
        event.type === "assistant-text-delta",
    )
    .map((event) => event.text)
    .join("");
}

export function approvalTurn(
  sessionId: string,
  messageId: string,
  reviewId: string,
  decision: ApprovalTurn["decision"] = { type: "approve" },
): ApprovalTurn {
  return { sessionId, messageId, reviewId, decision };
}

export function useTemporaryDirectories(prefix: string): () => string {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return () => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
}
