import type {
  AgentEvent,
  ApprovalBatchPosition,
  ApprovalDecision,
  BatchAction,
  BatchDecision,
  WorkspaceWrite,
} from "./contracts.js";
import { decideOperation, runOperation } from "./session-operation.js";
import type {
  ActiveRun,
  SessionTurnExecutorOptions,
  StableTurnIdentity,
} from "./session-turn-executor.js";
import { askStudent } from "./session-interactions.js";

interface BatchWriteChoice {
  readonly decision: ApprovalDecision;
  readonly reason: string | undefined;
  readonly remaining: boolean;
  readonly effect: WorkspaceWrite | null;
}

export interface BatchDependencies {
  readonly options: SessionTurnExecutorOptions;
  /** Records, asks (unless already approved) and applies one write of the batch. */
  readonly decideWrite: (
    action: Extract<BatchAction, { readonly kind: "write" }>,
    batch: { readonly position: ApprovalBatchPosition; readonly approved: boolean },
  ) => Promise<BatchWriteChoice>;
}

/**
 * A write that belongs to a batch is resumed through its batch, which recovery replays with every
 * decision already stored; only a single approval resumes on its own. Batch members carry
 * `:batch-<position>` after the interrupt identity.
 */
export function isBatchApproval(approvalId: string): boolean {
  return /:batch-\d+$/u.test(approvalId);
}

/** One compact line per action, shown under the current one so the student sees what follows. */
export function batchSummary(action: BatchAction): string {
  if (action.kind === "questions") return "marea_ask_user";
  if (action.kind === "write") return `write_file ${action.path}`;
  const target =
    action.request.arguments.command ?? action.request.arguments.path ?? action.request.summary;
  return `${action.request.tool} ${target}`;
}

/**
 * Asks for every action of a batch in order, recording each decision as it is taken, and resumes
 * only when all are decided. "Approve all" approves the current action and the rest of this batch;
 * questions are still asked. Decisions stored before a restart are reused, so only the missing
 * ones are asked again. Rejecting one action never cancels the others.
 */
export async function* batchEvents(
  dependencies: BatchDependencies,
  event: Extract<AgentEvent, { readonly type: "approval-batch-required" }>,
  active: ActiveRun,
  identity: StableTurnIdentity,
  assistantText: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const { options } = dependencies;
  const resume = options.agent.resumeBatch?.bind(options.agent);
  if (resume === undefined) throw new Error("The runtime cannot resume a batch of approvals.");
  const summaries = event.actions.map(batchSummary);
  const decisions: BatchDecision[] = [];
  let approved = false;
  let cancelled = false;
  for (const [offset, action] of event.actions.entries()) {
    const position = {
      position: offset + 1,
      total: event.actions.length,
      remaining: summaries.slice(offset + 1),
    };
    if (action.kind === "questions") {
      const reply = await askStudent(options, action.request, identity, signal);
      if (reply.type === "cancel") {
        cancelled = true;
        break;
      }
      decisions.push({ kind: "questions", values: reply.values });
    } else if (action.kind === "operation") {
      if (options.operations === undefined)
        throw new Error("Operations are unavailable in this turn.");
      const choice = await decideOperation(
        options,
        options.operations,
        action.request,
        active,
        identity,
        signal,
        { position, approved },
      );
      approved ||= choice.remaining;
      const result =
        choice.decision === "approved"
          ? yield* runOperation(options, options.operations, action.request, identity, signal)
          : null;
      decisions.push({
        kind: "operation",
        decision: choice.decision,
        reason: choice.reason,
        result,
      });
    } else {
      const choice = await dependencies.decideWrite(action, { position, approved });
      approved ||= choice.remaining;
      decisions.push({
        kind: "write",
        decision: choice.decision,
        reason: choice.reason,
        effect: choice.effect,
      });
    }
  }
  if (cancelled) {
    yield { type: "turn-cancelled" };
  } else {
    signal.throwIfAborted();
    yield* resume(
      {
        ...active,
        messageId: identity.messageId,
        assistantText,
        reviewId: event.reviewId,
        actions: event.actions,
        decisions,
      },
      signal,
    );
  }
}
