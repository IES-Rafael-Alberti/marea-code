/** Deduplication key of the single terminal `turn-ended` event of a turn. */
export function turnEndedKey(messageId: string): string {
  return JSON.stringify([messageId, "terminal", "turn-ended"]);
}
