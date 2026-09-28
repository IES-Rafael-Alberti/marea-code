import type { AgentEvent } from "./contracts.js";
import type { OperationRequest, OperationExecutor } from "./operation-contracts.js";
import type {
  ActiveRun,
  SessionTurnExecutorOptions,
  StableTurnIdentity,
} from "./session-turn-executor.js";
import { interactionAfterAbort } from "./turn-interaction.js";
import type { ApprovalReply } from "./contracts.js";

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
  if (
    active.snapshot.teacherToolPolicy.restrictions.some(
      (rule) => rule.tool === request.tool && rule.effect === "deny",
    )
  )
    throw new Error("The teacher policy denies this operation.");
  await operations.prepare(request);
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
    (await interactionAfterAbort<ApprovalReply>(
      () =>
        options.studentInterface.confirmWrite({
          ...identity,
          approvalId: request.approvalId,
          toolName: request.tool,
          arguments: request.arguments,
          path: request.arguments.path ?? "",
          content: JSON.stringify(request.arguments, null, 2),
          summary: request.arguments.command ?? request.summary,
        }),
      signal,
      "rejected",
      "Operation authorization failed.",
    ));
  const { decision, reason: suppliedReason } =
    typeof reply === "string" ? { decision: reply, reason: undefined } : reply;
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
  return (async function* () {
    let result: string | null = null;
    if (decision === "approved") {
      const callId = request.approvalId;
      yield { type: "tool-started", callId, name: request.tool, arguments: request.arguments };
      try {
        signal.throwIfAborted();
        await options.evidence?.beginAgent(identity.messageId);
        result = await operations.execute(request, signal);
        await options.evidence?.capture("agent", identity.messageId);
        await options.flushOutbox();
      } catch (error) {
        yield {
          type: "tool-finished",
          callId,
          failed: true,
          result: error instanceof Error ? error.message : "The operation failed without an error.",
        };
        throw error;
      }
      yield { type: "tool-finished", callId, failed: false, result };
    }
    signal.throwIfAborted();
    yield* resume(
      { ...active, ...identity, ...request, assistantText, decision, reason, result },
      signal,
    );
  })();
}
