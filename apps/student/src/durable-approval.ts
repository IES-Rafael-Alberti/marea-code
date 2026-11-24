import type { AgentRuntime as DeepAgentRuntime } from "@marea/deepagents-adapter";

import { parseApprovalId, parseWriteRequest, StudentAgentBridgeError } from "./bridge-parsing.js";
import type { AgentApprovalTurn } from "./contracts.js";
import type { ApprovalId, StudentRunSnapshot } from "@marea/protocol";
import type { WriteRequest } from "./write-request.js";

const INTERNAL_WRITE_TOOL_NAME = "marea_write_file";

export interface PendingApproval extends WriteRequest {
  readonly approvalId: ApprovalId;
  readonly messageId: string;
  readonly reviewId: string;
  readonly summary: string;
}

interface DurableApprovalContext extends WriteRequest {
  readonly snapshot: StudentRunSnapshot;
  readonly summary: string;
}

export type DurableAgentApprovalTurn = AgentApprovalTurn & DurableApprovalContext;

export async function approvalStateFor(
  runtime: DeepAgentRuntime,
  turn: DurableAgentApprovalTurn,
  assistantText: string,
): Promise<PendingApproval | null> {
  const recovery = await runtime.recoverMessage({
    assistantText,
    messageId: turn.messageId,
    sessionId: turn.runId,
  });
  if (recovery?.type === "in-progress") {
    return {
      approvalId: turn.approvalId,
      content: turn.content,
      messageId: turn.messageId,
      path: turn.path,
      reviewId: turn.approvalId,
      summary: turn.summary,
    };
  }
  if (recovery?.type !== "pending-approval") return null;
  const event = recovery.events.find((candidate) => candidate.type === "tool-approval-required");
  if (event?.toolName !== INTERNAL_WRITE_TOOL_NAME) {
    throw new StudentAgentBridgeError("The DeepAgents approval is not pending for this message.");
  }
  const approvalId = parseApprovalId(event.reviewId);
  if (approvalId !== turn.approvalId) {
    throw new StudentAgentBridgeError("The DeepAgents approval is not pending for this message.");
  }
  const pending = {
    ...parseWriteRequest(event.arguments),
    approvalId,
    messageId: turn.messageId,
    reviewId: event.reviewId,
    summary: event.description,
  };
  assertPersistedApprovalContext(turn, pending);
  return pending;
}

function assertPersistedApprovalContext(
  turn: DurableAgentApprovalTurn,
  pending: PendingApproval,
): void {
  const persisted = durableApprovalContext(turn);
  if (
    persisted.content !== pending.content ||
    persisted.path !== pending.path ||
    persisted.summary !== pending.summary
  ) {
    throw new StudentAgentBridgeError("The persisted approval does not match DeepAgents state.");
  }
}

export function assertDurableApprovalContext(
  turn: AgentApprovalTurn,
): asserts turn is DurableAgentApprovalTurn {
  const candidate: Partial<DurableApprovalContext> = turn;
  if (
    typeof candidate.content !== "string" ||
    typeof candidate.path !== "string" ||
    candidate.snapshot === undefined ||
    typeof candidate.summary !== "string"
  ) {
    throw new StudentAgentBridgeError("The persisted approval context is incomplete.");
  }
}

export function durableApprovalContext(turn: DurableAgentApprovalTurn): DurableApprovalContext {
  return {
    content: turn.content,
    path: turn.path,
    snapshot: turn.snapshot,
    summary: turn.summary,
  };
}
