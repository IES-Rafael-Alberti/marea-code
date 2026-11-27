import type { SessionTurnExecutorOptions, StableTurnIdentity } from "./session-turn-executor.js";
import type { TurnProgress } from "./turn-progress.js";

type TextOptions = Pick<SessionTurnExecutorOptions, "localSession" | "studentInterface">;

/** The text left once the interrupted answer at its end is dropped. */
function discardTail(text: string, discardedLength: number): string {
  return text.slice(0, Math.max(0, text.length - discardedLength));
}

/** The turn text once a text event of the adapter is applied to it. */
export function textAfter(
  text: string,
  event:
    | { readonly type: "assistant-text-delta"; readonly text: string }
    | { readonly type: "assistant-text-restarted"; readonly discardedLength: number },
): string {
  return event.type === "assistant-text-delta"
    ? text + event.text
    : discardTail(text, event.discardedLength);
}

/** Stores a delta before the screen shows it, so a stop never loses text the student saw. */
export async function appendText(
  options: TextOptions,
  identity: StableTurnIdentity,
  text: string[],
  delta: string,
  progress: TurnProgress,
): Promise<void> {
  text.push(delta);
  await options.localSession.updateTurnText(identity.messageId, text.join(""));
  await progress.publish(text.join(""));
  options.studentInterface.present({ ...identity, type: "assistant-text", text: delta });
}

/**
 * Drops the interrupted answer at the end of the turn text before its regeneration arrives.
 * The shorter text is stored before Marea reads the next event, so a stop in between resumes
 * from text the adapter accepts; the screen then shows the new answer in its place.
 */
export async function restartText(
  options: TextOptions,
  identity: StableTurnIdentity,
  text: string[],
  discardedLength: number,
  progress: TurnProgress,
): Promise<void> {
  const current = text.join("");
  const kept = discardTail(current, discardedLength);
  text.splice(0, text.length, kept);
  await options.localSession.updateTurnText(identity.messageId, kept);
  progress.restart();
  options.studentInterface.present({
    ...identity,
    type: "assistant-text-restarted",
    discardedLength: current.length - kept.length,
  });
}
