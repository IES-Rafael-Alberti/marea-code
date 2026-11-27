import type { AgentEvent } from "./contracts.js";
import { assertKnownPrefix, keptText, type RecoveredGraphTurn } from "./recovery-state.boundary.js";
import { realign, type SupersededText } from "./superseded-text.js";

export interface Continuation {
  /** The turn text the continued run builds on. */
  readonly assistantText: string;
  /** What the caller applies before the continued run's own events. */
  readonly events: readonly AgentEvent[];
  /** Carried by every later journal record, so a caller that kept old text is still accepted. */
  readonly superseded: SupersededText | null;
}

/**
 * Prepares a turn whose graph stopped in progress. Its checkpoint never holds the text of an
 * interrupted model call; that call is made again and its answer can differ, so the caller
 * discards that partial text instead of expecting the new answer to repeat it.
 *
 * The discard needs no journal write of its own: it only shortens the caller's text, which stays
 * a prefix of the journal until the continued run records the new answer, and that record
 * carries the superseded text.
 */
export function beginContinuation(
  persistedText: string | undefined,
  recovered: RecoveredGraphTurn,
): Continuation {
  const held = persistedText ?? "";
  assertKnownPrefix(recovered, held);
  const assistantText = keptText(recovered);
  const realignment = realign(held, assistantText);
  return {
    assistantText,
    events: realignment.events,
    superseded: realignment.superseded ?? recovered.superseded,
  };
}
