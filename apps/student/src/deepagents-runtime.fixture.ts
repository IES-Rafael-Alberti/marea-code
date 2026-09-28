/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { type MareaModelGateway } from "@marea/deepagents-adapter";
import type {
  AgentCheckpoint,
  AgentEvent as DeepAgentEvent,
  AgentModel,
  AgentRecovery,
  AgentRuntime as DeepAgentRuntime,
  AgentRuntimeOptions,
  ApprovalTurn,
  MessageIdentity,
  MessageTurn,
} from "@marea/deepagents-adapter";
import {
  ApprovalIdSchema,
  CURRENT_PROTOCOL_VERSION,
  ModelGatewayStreamChunkSchema,
  RunIdSchema,
  Sha256DigestSchema,
  SnapshotIdSchema,
  type ModelGatewayRequest,
  type ModelGatewayStreamChunk,
  type StudentRunSnapshot,
} from "@marea/protocol";

import type { AgentApprovalTurn, AgentMessageTurn, WorkspaceWrite } from "./contracts.js";
import {
  createDeepAgentsStudentRuntime,
  type DeepAgentRuntimeFactory,
} from "./deepagents-runtime.boundary.js";

export const checkpoint: AgentCheckpoint = { kind: "marea-agent-checkpoint" };
export const model: AgentModel = { kind: "marea-agent-model" };
export const runId = RunIdSchema.parse("run:1");
export const approvalId = ApprovalIdSchema.parse("approval:1");
const digest = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
export const effect: WorkspaceWrite = { digest, operation: "created", path: "notes.txt" };

export type PersistedApprovalTurn = AgentApprovalTurn & {
  readonly content: string;
  readonly path: string;
  readonly snapshot: StudentRunSnapshot;
  readonly summary: string;
};

export function snapshot(
  id = "snapshot:1",
  restriction: "require-approval" | "deny" | null = "require-approval",
): StudentRunSnapshot {
  return {
    id: SnapshotIdSchema.parse(id),
    agentMode: "tutoring",
    modelAlias: "marea",
    prompt: { version: "prompt:1", digest, content: "Teach clearly." },
    didacticSkills: [],
    teacherToolPolicy: {
      version: "tools:1",
      restrictions: restriction === null ? [] : [{ tool: "write_file", effect: restriction }],
    },
  };
}

export function message(snapshotValue = snapshot()): AgentMessageTurn {
  return { messageId: "message:1", runId, snapshot: snapshotValue, text: "Help me" };
}

export function approval(
  decision: "approved" | "rejected",
  result: WorkspaceWrite | null,
  messageId = "message:1",
): PersistedApprovalTurn {
  return {
    approvalId,
    content: "content",
    decision,
    effect: result,
    messageId,
    path: "notes.txt",
    runId,
    snapshot: snapshot(),
    summary: "Create notes.",
  };
}

export async function collect(events: AsyncIterable<import("./contracts.js").AgentEvent>) {
  const values: import("./contracts.js").AgentEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

export function approvalRequired(
  overrides: Partial<Extract<DeepAgentEvent, { readonly type: "tool-approval-required" }>> = {},
): Extract<DeepAgentEvent, { readonly type: "tool-approval-required" }> {
  return {
    type: "tool-approval-required",
    reviewId: approvalId,
    toolName: "marea_write_file",
    arguments: { path: "notes.txt", content: "content" },
    description: "Create notes.",
    allowedDecisions: ["approve", "amend", "reject"],
    ...overrides,
  };
}

class FakeDeepRuntime implements DeepAgentRuntime {
  messages: DeepAgentEvent[] = [
    { type: "assistant-text-delta", text: "Thinking" },
    approvalRequired(),
  ];
  resumes: ApprovalTurn[] = [];
  messageTurns: MessageTurn[] = [];
  failResume = false;
  executeRejected = false;
  forcedRecovery: AgentRecovery | undefined;
  recoveries: MessageIdentity[] = [];
  executeTool: AgentRuntimeOptions["approvalTool"] | null = null;
  toolArguments: Readonly<Record<string, string>> = {
    path: "notes.txt",
    content: "content",
  };
  toolResult: string | null = null;
  startedMessageId: string | null = null;

  async recoverMessage(turn: MessageIdentity): Promise<AgentRecovery | null> {
    this.recoveries.push(turn);
    if (this.forcedRecovery !== undefined) return this.forcedRecovery;
    if (turn.messageId !== this.startedMessageId) return null;
    const pending = this.messages.find((event) => event.type === "tool-approval-required");
    if (pending === undefined) return null;
    const fullText = this.messages
      .filter(
        (event): event is Extract<DeepAgentEvent, { readonly type: "assistant-text-delta" }> =>
          event.type === "assistant-text-delta",
      )
      .map((event) => event.text)
      .join("");
    const prefix = turn.assistantText ?? "";
    if (!fullText.startsWith(prefix)) throw new Error("invalid replay prefix");
    return {
      type: "pending-approval" as const,
      assistantText: fullText,
      events: [
        ...(fullText.length === prefix.length
          ? []
          : [{ type: "assistant-text-delta" as const, text: fullText.slice(prefix.length) }]),
        pending,
      ],
    };
  }

  async *streamMessage(turn: MessageTurn, _signal: AbortSignal): AsyncIterable<DeepAgentEvent> {
    const recovery = await this.recoverMessage(turn);
    if (recovery !== null) {
      yield* recovery.events;
      return;
    }
    this.startedMessageId = turn.messageId;
    this.messageTurns.push(turn);
    yield* this.messages;
  }

  async *resumeApproval(turn: ApprovalTurn, _signal: AbortSignal): AsyncIterable<DeepAgentEvent> {
    this.resumes.push(turn);
    if (turn.messageId !== this.startedMessageId) {
      throw new Error("The DeepAgents approval is not pending for this message.");
    }
    if (this.failResume) throw new Error("resume failed");
    if ((turn.decision.type === "approve" || this.executeRejected) && this.executeTool !== null) {
      this.toolResult = await this.executeTool.execute(this.toolArguments);
    }
    yield { type: "tool-approval-submitted", decision: turn.decision.type };
    yield { type: "turn-completed" };
  }
}

export class DurableApprovalGateway implements MareaModelGateway {
  readonly requests: ModelGatewayRequest[] = [];

  async *stream(request: ModelGatewayRequest): AsyncIterable<ModelGatewayStreamChunk> {
    this.requests.push(request);
    yield gatewayChunk(request, 0, "started");
    if (this.requests.length === 1) {
      yield gatewayChunk(request, 1, "text-delta", { delta: "Preparing. " });
      yield gatewayChunk(request, 2, "tool-call", {
        callId: "write-1",
        tool: "write_file",
        arguments: { path: "notes.txt", content: "content" },
      });
      yield gatewayChunk(request, 3, "completed", {
        finishReason: "tool-call",
        usage: { inputTokens: 2, outputTokens: 1 },
      });
      return;
    }
    yield gatewayChunk(request, 1, "text-delta", { delta: "saved" });
    yield gatewayChunk(request, 2, "completed", {
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 1 },
    });
  }
}

function gatewayChunk(
  request: ModelGatewayRequest,
  sequence: number,
  event: ModelGatewayStreamChunk["event"],
  fields: Readonly<Record<string, string | object>> = {},
): ModelGatewayStreamChunk {
  return ModelGatewayStreamChunkSchema.parse({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: request.requestId,
    modelAlias: "marea",
    emittedAt: "2026-09-07T12:00:00.000Z",
    sequence,
    event,
    ...fields,
  });
}

export function harness(operations = false) {
  const deep = new FakeDeepRuntime();
  const options: AgentRuntimeOptions[] = [];
  const factory: DeepAgentRuntimeFactory = (value) => {
    options.push(value);
    deep.executeTool = value.approvalTool;
    return deep;
  };
  return {
    deep,
    options,
    runtime: createDeepAgentsStudentRuntime({
      checkpoint,
      createRuntime: factory,
      model,
      operations,
    }),
  };
}
