/** One stored text (student input, assistant reply) never exceeds the largest event text. */
export const MAX_STORED_TEXT = 65_536;

/**
 * A pending write keeps its full content so an approved write can be applied after a restart,
 * while events carry at most {@link MAX_STORED_TEXT} of it.
 */
export const MAX_STORED_APPROVAL_CONTENT = 1_048_576;

export function clipStoredText(text: string): string {
  return text.slice(0, MAX_STORED_TEXT);
}
