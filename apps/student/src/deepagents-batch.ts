import {
  QUESTION_TOOL_NAME,
  parseQuestions,
  questionAnswers,
  type AgentEvent as DeepAgentEvent,
  type ApprovalDecision as DeepApprovalDecision,
} from "@marea/deepagents-adapter";

import { parseApprovalId, parseWriteRequest, StudentAgentBridgeError } from "./bridge-parsing.js";
import type {
  AgentBatchTurn,
  AgentEvent,
  BatchAction,
  BatchDecision,
  WorkspaceWrite,
} from "./contracts.js";
import type { OperationMediator } from "./operation-mediator.js";
import type { WriteRequest } from "./write-request.js";

const INTERNAL_WRITE_TOOL_NAME = "marea_write_file";

type ApprovalEvent = Extract<DeepAgentEvent, { readonly type: "tool-approval-required" }>;

interface BatchMediators {
  readonly operations: readonly OperationMediator[];
  readonly writes: { authorize(request: WriteRequest, result: WorkspaceWrite): void };
}

/**
 * Each action of a batch gets its own approval identity, derived from the interrupt and its
 * position, so its decision is stored and resolved on its own. A single action keeps the
 * interrupt identity itself, as approvals did before batches.
 */
export function batchApprovalId(reviewId: string, index: number) {
  return parseApprovalId(`${reviewId}:batch-${String(index)}`);
}

export function batchEventFor(event: ApprovalEvent, mediators: BatchMediators): AgentEvent {
  const actions = event.actions.map((action): BatchAction => {
    const approvalId = batchApprovalId(event.reviewId, action.index);
    if (action.toolName === QUESTION_TOOL_NAME)
      return {
        index: action.index,
        kind: "questions",
        request: { interruptId: approvalId, questions: parseQuestions(action.arguments) },
      };
    const operation = mediators.operations.find((candidate) => candidate.name === action.toolName);
    if (operation !== undefined)
      return {
        index: action.index,
        kind: "operation",
        request: {
          approvalId,
          tool: operation.operation,
          arguments: action.arguments,
          summary: action.description,
        },
      };
    if (action.toolName !== INTERNAL_WRITE_TOOL_NAME)
      throw new StudentAgentBridgeError("DeepAgents requested an unsupported tool.");
    const request = parseWriteRequest(action.arguments);
    return {
      index: action.index,
      kind: "write",
      approvalId,
      path: request.path,
      content: request.content,
      summary: action.description,
    };
  });
  return { type: "approval-batch-required", reviewId: event.reviewId, actions };
}

function toolNameOf(action: BatchAction, mediators: BatchMediators): string {
  if (action.kind === "questions") return QUESTION_TOOL_NAME;
  if (action.kind === "write") return INTERNAL_WRITE_TOOL_NAME;
  return toolMediator(action, mediators).name;
}

/**
 * Authorizes what Marea already carried out for each approved action and returns one upstream
 * decision per action, in order. Effects were applied before resuming, so the tools only replay
 * their recorded results.
 */
export function batchDecisions(
  turn: AgentBatchTurn,
  mediators: BatchMediators,
): {
  readonly toolName: string;
  readonly decision: DeepApprovalDecision;
  readonly decisions: readonly DeepApprovalDecision[];
} {
  const [first, ...rest] = turn.actions;
  if (first === undefined) throw new StudentAgentBridgeError("A batch has no actions.");
  if (turn.decisions.length > turn.actions.length) throw countMismatch();
  const decisionAt = (index: number): BatchDecision => {
    const decision = turn.decisions[index];
    if (decision === undefined) throw countMismatch();
    return decision;
  };
  const decision = upstreamDecision(first, decisionAt(0), mediators);
  const decisions = [
    decision,
    ...rest.map((action, index) => upstreamDecision(action, decisionAt(index + 1), mediators)),
  ];
  return { toolName: toolNameOf(first, mediators), decision, decisions };
}

function countMismatch(): StudentAgentBridgeError {
  return new StudentAgentBridgeError("Every batch action needs exactly one decision.");
}

function upstreamDecision(
  action: BatchAction,
  decision: BatchDecision,
  mediators: BatchMediators,
): DeepApprovalDecision {
  if (action.kind === "questions") {
    if (decision.kind !== "questions") throw mismatch();
    const questions = action.request.questions;
    return {
      type: "amend",
      arguments: {
        questions: JSON.stringify(questions),
        answers: JSON.stringify(questionAnswers(questions, decision.values)),
      },
    };
  }
  if (decision.kind !== action.kind) throw mismatch();
  if (decision.decision === "rejected")
    return { type: "reject", reason: decision.reason ?? "The student rejected this action." };
  // The kinds match, so the action has the same shape as its decision.
  if (decision.kind === "operation") {
    if (decision.result === null)
      throw new StudentAgentBridgeError("The operation has no recorded result.");
    const operation = action as Extract<BatchAction, { readonly kind: "operation" }>;
    toolMediator(operation, mediators).authorize(operation.request.arguments, decision.result);
  } else {
    if (decision.effect === null)
      throw new StudentAgentBridgeError("The write has no recorded effect.");
    mediators.writes.authorize(
      action as Extract<BatchAction, { readonly kind: "write" }>,
      decision.effect,
    );
  }
  return { type: "approve" };
}

function mismatch(): StudentAgentBridgeError {
  return new StudentAgentBridgeError("A batch decision does not match its action.");
}

function toolMediator(
  action: Extract<BatchAction, { readonly kind: "operation" }>,
  mediators: BatchMediators,
): OperationMediator {
  const mediator = mediators.operations.find(
    (candidate) => candidate.operation === action.request.tool,
  );
  if (mediator === undefined) throw new StudentAgentBridgeError("This operation is unavailable.");
  return mediator;
}
