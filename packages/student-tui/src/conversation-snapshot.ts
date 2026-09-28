import type {
  ConversationSnapshot,
  ConversationToolCall,
  ConversationToolFinish,
  ConversationToolStart,
  TurnFailureInfo,
} from "./conversation-contracts.js";

/**
 * Pure snapshot edits the conversation controller applies. Kept apart from the
 * controller so its turn bookkeeping stays readable.
 */

type MutableSnapshot = { -readonly [K in keyof ConversationSnapshot]: ConversationSnapshot[K] };

/**
 * Attaches a classified failure, if there is one. An unclassified rejection
 * leaves the key absent so no stale failure can linger on the snapshot.
 */
export function withFailure(
  snapshot: Omit<ConversationSnapshot, "failure">,
  failure: TurnFailureInfo | undefined,
): ConversationSnapshot {
  if (failure === undefined) return snapshot;
  return { ...snapshot, failure };
}

/** Drops the question request from any snapshot that is not asking one. */
export function withoutStaleQuestions(snapshot: ConversationSnapshot): ConversationSnapshot {
  if (snapshot.status === "questions") return snapshot;
  const mutable: MutableSnapshot = { ...snapshot };
  delete mutable.questions;
  return mutable;
}

/** Adds a running tool row. */
export function startTool(
  rows: readonly ConversationToolCall[],
  call: ConversationToolStart,
): readonly ConversationToolCall[] {
  return [...rows, { ...call, outcome: null }];
}

/** Records the outcome on the row with the same call id. */
export function finishTool(
  rows: readonly ConversationToolCall[],
  finish: ConversationToolFinish,
): readonly ConversationToolCall[] {
  return rows.map((row) =>
    row.callId === finish.callId
      ? { ...row, outcome: { failed: finish.failed, result: finish.result } }
      : row,
  );
}
