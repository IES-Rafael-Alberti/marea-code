import type { AgentEvent } from "./contracts.js";

/**
 * Text a caller may still hold after the adapter discarded it: a model call interrupted
 * mid-answer is made again, so its partial text is superseded by the regenerated answer.
 * `keptLength` characters of the turn text survive; `text` follows them in the caller's copy.
 */
export interface SupersededText {
  readonly keptLength: number;
  readonly text: string;
}

export interface Realignment {
  /** What the caller must apply to its copy: a discard, then the text it lacks. */
  readonly events: readonly AgentEvent[];
  /** The text the caller is told to discard, or null when it discards nothing. */
  readonly superseded: SupersededText | null;
}

export function commonPrefixLength(left: string, right: string): number {
  let length = 0;
  while (length < left.length && left[length] === right[length]) length += 1;
  return length;
}

/**
 * Whether `held` is text the caller can legitimately hold for a turn whose durable text is
 * `durable`: a prefix of it, or a prefix of the text it was told to discard but may not yet
 * have discarded when the process stopped.
 */
export function isKnownPrefix(
  durable: string,
  superseded: SupersededText | null,
  held: string,
): boolean {
  if (durable.startsWith(held)) return true;
  return (
    superseded !== null &&
    `${durable.slice(0, superseded.keptLength)}${superseded.text}`.startsWith(held)
  );
}

/** Brings a caller holding `held` to `target`, discarding only what differs. */
export function realign(held: string, target: string): Realignment {
  const kept = commonPrefixLength(held, target);
  const discarded = held.length - kept;
  const missing = target.slice(kept);
  return {
    events: [
      ...(discarded > 0
        ? [{ type: "assistant-text-restarted" as const, discardedLength: discarded }]
        : []),
      ...(missing.length > 0 ? [{ type: "assistant-text-delta" as const, text: missing }] : []),
    ],
    superseded: discarded > 0 ? { keptLength: kept, text: held.slice(kept) } : null,
  };
}
