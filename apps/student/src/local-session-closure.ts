import { EffectIdSchema, MessageIdSchema } from "@marea/protocol";

import type { Clock, IdSource, StoredRun, StoredTurn } from "./contracts.js";
import { finishStoredTurn, resolveStoredApproval } from "./local-session-turns.js";
import { appendKeyedEvent } from "./outbox-append.js";
import { recordStartupProgress } from "./local-startup.js";
import { selectedStartedTurn } from "./pending-turn.js";
import { turnEndedKey } from "./turn-keys.js";

const SUPERSEDED_REASON = "The student moved on before this write was answered.";

function rejectPendingApprovals(
  run: StoredRun,
  turn: StoredTurn,
  ids: IdSource,
  clock: Clock,
): StoredRun {
  let next = run;
  // Stryker disable next-line ArrayDeclaration: a non-approval placeholder never matches any message, as an empty list.
  for (const approval of run.pendingApprovals ?? []) {
    if (
      approval.messageId !== turn.messageId ||
      run.approvals.some((resolved) => resolved.approvalId === approval.approvalId)
    ) {
      continue;
    }
    next = resolveStoredApproval(
      next,
      { approvalId: approval.approvalId, decision: "rejected", reason: SUPERSEDED_REASON },
      (sequence, occurredAt) => ({
        approvalId: approval.approvalId,
        decision: "rejected",
        effectId: EffectIdSchema.parse(approval.effectId),
        eventId: ids.event(),
        eventType: "approval-resolved",
        messageId: MessageIdSchema.parse(turn.messageId),
        occurredAt,
        reason: SUPERSEDED_REASON,
        sequence,
      }),
      clock,
    );
  }
  return next;
}

function recordTurnEnded(run: StoredRun, turn: StoredTurn, ids: IdSource, clock: Clock): StoredRun {
  if (turn.kind === "startup") return recordStartupProgress(run, "cancelled", ids, clock);
  return appendKeyedEvent(run, turnEndedKey(turn.messageId), (sequence) => ({
    eventId: ids.event(),
    eventType: "turn-ended",
    messageId: MessageIdSchema.parse(turn.messageId),
    occurredAt: clock.now(),
    sequence,
    state: "cancelled",
  }));
}

/** Closes one abandoned turn as cancelled; the teacher already saw its `turn-failed` event. */
function closeTurn(run: StoredRun, turn: StoredTurn, ids: IdSource, clock: Clock): StoredRun {
  const rejected = rejectPendingApprovals(run, turn, ids, clock);
  const finished = finishStoredTurn(rejected, turn.messageId, "cancelled", "", ids, clock);
  return recordTurnEnded(finished, turn, ids, clock);
}

/** A new message supersedes every other turn that already failed. */
export function closeFailedTurnsExcept(
  run: StoredRun,
  messageId: string,
  ids: IdSource,
  clock: Clock,
): StoredRun {
  return run.turns
    .filter(
      (turn) =>
        turn.state === "started" && turn.lastFailure !== undefined && turn.messageId !== messageId,
    )
    .reduce((next, turn) => closeTurn(next, turn, ids, clock), run);
}

/** At startup only the selected pending turn stays open; the rest are closed. */
export function closeSupersededTurns(run: StoredRun, ids: IdSource, clock: Clock): StoredRun {
  const selected = selectedStartedTurn(run);
  return run.turns
    .filter((turn) => turn.state === "started" && turn !== selected)
    .reduce((next, turn) => closeTurn(next, turn, ids, clock), run);
}
