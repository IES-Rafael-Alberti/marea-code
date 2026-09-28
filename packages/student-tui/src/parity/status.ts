import { fill, type HintCopy, type ParityCopy, type StatusCopy } from "./copy.js";

/**
 * The one-row status bar: what the session is doing, what keys are available
 * right now, and the context the student is working in.
 *
 * An activity that takes time counts its seconds and is shown in the accent
 * colour; one that is simply a state, such as being ready, is dim and still.
 */

type Activity = keyof StatusCopy | "tool";

export interface StatusState {
  readonly activity: Activity;
  readonly branch: string;
  readonly hint: keyof HintCopy | "none";
  readonly model: string;
  /** The tool name, when the activity is a running tool. */
  readonly toolName: string;
  /** Milliseconds the activity has been running, or null when it is still. */
  readonly elapsedMs: number | null;
}

export interface StatusLine {
  readonly context: string;
  readonly elapsed: string;
  readonly hint: string;
  readonly label: string;
  /** Whether the activity is running, and so shown in the accent colour. */
  readonly running: boolean;
}

function labelFor(state: StatusState, copy: StatusCopy): string {
  return state.activity === "tool" ? state.toolName : copy[state.activity];
}

/**
 * The bar's four parts. Empty strings mean "show nothing", which keeps the
 * separators out of the component.
 */
export function statusLine(state: StatusState, copy: ParityCopy): StatusLine {
  const running = state.elapsedMs !== null;
  const seconds = Math.floor((state.elapsedMs ?? 0) / 1000);
  return {
    context: [state.model, state.branch].filter((part) => part !== "").join(" · "),
    elapsed: running && seconds > 0 ? fill(copy.seconds, { seconds }) : "",
    hint: state.hint === "none" ? "" : copy.hints[state.hint],
    label: labelFor(state, copy.status),
    running,
  };
}

export const INITIAL_STATUS: StatusState = Object.freeze({
  activity: "starting",
  branch: "",
  elapsedMs: 0,
  hint: "turn",
  model: "",
  toolName: "",
});
