import type { ConversationMessage } from "./conversation-contracts.js";

/** The messages once the last `discardedLength` characters of the final answer are dropped. */
export function withoutAnswerTail(
  earlier: readonly ConversationMessage[],
  answer: string,
  discardedLength: number,
): readonly ConversationMessage[] {
  const kept = answer.slice(0, Math.max(0, answer.length - discardedLength));
  return Object.freeze(
    kept.length === 0
      ? [...earlier]
      : [...earlier, Object.freeze({ author: "marea" as const, text: kept })],
  );
}

/** How much of the final answer a new snapshot dropped, or zero when it only grew. */
export function droppedAnswerLength(
  previous: readonly ConversationMessage[],
  next: readonly ConversationMessage[],
): number {
  const index = previous.length - 1;
  const prior = previous[index];
  if (prior?.author !== "marea") return 0;
  return Math.max(0, prior.text.length - (next[index]?.text.length ?? 0));
}
