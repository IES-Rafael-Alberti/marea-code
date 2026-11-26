import type { AgentEvent } from "./contracts.js";
import { resolvedReply } from "./approval-reply.js";
import type { OperationRequest, OperationExecutor } from "./operation-contracts.js";
import type {
  ActiveRun,
  SessionTurnExecutorOptions,
  StableTurnIdentity,
} from "./session-turn-executor.js";
import { interactionAfterAbort } from "./turn-interaction.js";
import { modelFeedback } from "./operation-feedback.boundary.js";
import type { ApprovalBatchPosition, ApprovalReply } from "./contracts.js";

export interface ApprovalChoice {
  readonly decision: "approved" | "rejected";
  readonly reason: string | undefined;
  /** The student approved this action and the remaining actions of its batch. */
  readonly remaining: boolean;
}

/**
 * Checks policy, records the request, asks the student (unless a decision is stored or the batch
 * was already approved) and records the decision. It never runs the operation.
 */
export async function decideOperation(
  options: SessionTurnExecutorOptions,
  operations: OperationExecutor,
  request: OperationRequest,
  active: ActiveRun,
  identity: StableTurnIdentity,
  signal: AbortSignal,
  batch?: { readonly position: ApprovalBatchPosition; readonly approved: boolean },
): Promise<ApprovalChoice> {
  if (
    active.snapshot.teacherToolPolicy.restrictions.some(
      (rule) => rule.tool === request.tool && rule.effect === "deny",
    )
  )
    throw new Error("The teacher policy denies this operation.");
  try {
    await operations.prepare(request);
  } catch (error) {
    // A request the model got wrong goes back to it as a rejection; the student is not asked.
    const feedback = modelFeedback(error);
    if (feedback === null) throw error;
    return { decision: "rejected", reason: feedback, remaining: false };
  }
  await options.localSession.appendEvent(
    `operation:${request.approvalId}:requested`,
    (sequence, occurredAt) => ({
      eventType: "approval-requested",
      eventId: options.ids.event(),
      sequence,
      occurredAt,
      approvalId: request.approvalId,
      messageId: identity.messageId,
      tool: request.tool,
      summary: request.summary.slice(0, 2048),
      content: JSON.stringify(request.arguments, null, 2).slice(0, 65_536),
      truncated: JSON.stringify(request.arguments, null, 2).length > 65_536,
    }),
  );
  await options.flushOutbox();
  const stored = await options.localSession.findApproval(request.approvalId);
  const reply =
    stored ??
    (batch?.approved === true
      ? ("approved" as const)
      : await interactionAfterAbort<ApprovalReply>(
          () =>
            options.studentInterface.confirmWrite({
              ...identity,
              approvalId: request.approvalId,
              toolName: request.tool,
              arguments: request.arguments,
              path: request.arguments.path ?? "",
              content: JSON.stringify(request.arguments, null, 2),
              summary: request.arguments.command ?? request.summary,
              ...(batch === undefined ? {} : { batch: batch.position }),
            }),
          signal,
          "rejected",
          "Operation authorization failed.",
        ));
  const { decision, reason: suppliedReason, remaining } = resolvedReply(reply);
  const reason = suppliedReason?.slice(0, 2048);
  await options.localSession.resolveApproval(
    { approvalId: request.approvalId, decision, reason },
    (sequence, occurredAt) => ({
      eventType: "approval-resolved",
      eventId: options.ids.event(),
      sequence,
      occurredAt,
      approvalId: request.approvalId,
      messageId: identity.messageId,
      decision,
      reason,
    }),
  );
  signal.throwIfAborted();
  await options.flushOutbox();
  signal.throwIfAborted();
  return { decision, reason, remaining };
}

/** Runs one approved operation, presenting it as a tool row; returns its recorded result. */
export async function* runOperation(
  options: SessionTurnExecutorOptions,
  operations: OperationExecutor,
  request: OperationRequest,
  identity: StableTurnIdentity,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, string> {
  const callId = request.approvalId;
  yield { type: "tool-started", callId, name: request.tool, arguments: request.arguments };
  let result: string;
  try {
    signal.throwIfAborted();
    await options.evidence?.beginAgent(identity.messageId);
    result = await operations.execute(request, signal);
    await options.evidence?.capture("agent", identity.messageId);
    await options.flushOutbox();
  } catch (error) {
    const feedback = modelFeedback(error);
    yield {
      type: "tool-finished",
      callId,
      failed: true,
      result:
        feedback ??
        (error instanceof Error ? error.message : "The operation failed without an error."),
    };
    // The model gets the failure as the tool's result; only the machine's failures end the turn.
    if (feedback === null) throw error;
    return feedback;
  }
  yield { type: "tool-finished", callId, failed: false, result };
  return result;
}

export async function resolveOperation(
  options: SessionTurnExecutorOptions,
  operations: OperationExecutor,
  request: OperationRequest,
  active: ActiveRun,
  identity: StableTurnIdentity,
  assistantText: string,
  signal: AbortSignal,
): Promise<AsyncIterable<AgentEvent>> {
  const resume = options.agent.resumeOperation?.bind(options.agent);
  if (resume === undefined) throw new Error("The runtime cannot resume this operation.");
  const { decision, reason } = await decideOperation(
    options,
    operations,
    request,
    active,
    identity,
    signal,
  );
  return (async function* () {
    const result =
      decision === "approved"
        ? yield* runOperation(options, operations, request, identity, signal)
        : null;
    signal.throwIfAborted();
    yield* resume(
      { ...active, ...identity, ...request, assistantText, decision, reason, result },
      signal,
    );
  })();
}
