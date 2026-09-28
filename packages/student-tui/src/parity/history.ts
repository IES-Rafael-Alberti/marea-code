/**
 * The composer's input history.
 *
 * Up walks back through what the student has sent before and Down walks
 * forward again, ending at the draft that was on screen when they started.
 * The draft is never lost: stepping into history saves it, and coming back
 * restores it.
 */

export interface HistoryState {
  /** What the composer held before the student stepped into history. */
  readonly draft: string;
  /** Newest first. */
  readonly entries: readonly string[];
  /** -1 while the draft is showing, otherwise the entry on screen. */
  readonly index: number;
}

export function openHistory(entries: readonly string[] = []): HistoryState {
  return { draft: "", entries, index: -1 };
}

export interface HistoryStep {
  readonly state: HistoryState;
  /** What the composer should show, or null when nothing moved. */
  readonly text: string | null;
}

/** Moves to a position, or stays put when there is nothing there. */
function stepTo(state: HistoryState, index: number): HistoryStep {
  if (index === -1) return { state: { ...state, index }, text: state.draft };
  const text = state.entries[index];
  return text === undefined ? { state, text: null } : { state: { ...state, index }, text };
}

/** Steps to the entry before the one on screen, saving the draft first. */
export function olderEntry(state: HistoryState, current: string): HistoryStep {
  const draft = state.index === -1 ? current : state.draft;
  const step = stepTo({ ...state, draft }, state.index + 1);
  // Nothing older means nothing moved, so the draft is not captured either.
  return step.text === null ? { state, text: null } : step;
}

/** Steps forward, ending at the saved draft and then staying there. */
export function newerEntry(state: HistoryState): HistoryStep {
  return stepTo(state, state.index - 1);
}

/** Records a sent message and puts the composer back on a fresh draft. */
export function rememberEntry(state: HistoryState, text: string): HistoryState {
  return { draft: "", entries: [text, ...state.entries], index: -1 };
}
