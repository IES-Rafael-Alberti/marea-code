import type { CanonicalRunEvent, ClassSessionItem } from "@marea/protocol";
import type { SessionsState } from "./sessions-controller.js";

/** One row per session, the last listed winning. */
export function uniqueRuns(runs: readonly ClassSessionItem[]): ClassSessionItem[] {
  return [...new Map(runs.map((run) => [run.runId, run])).values()];
}

/** The events already read plus a newer page, one per sequence, the newer winning. */
export function mergedEvents(
  known: readonly CanonicalRunEvent[],
  page: readonly CanonicalRunEvent[],
): CanonicalRunEvent[] {
  const merged = new Map(known.map((event) => [event.sequence, event]));
  for (const event of page) merged.set(event.sequence, event);
  return [...merged.values()];
}

/** Freshness after a listing: with a session open, its own history decides. */
export function listedConnection(
  { runId, connection }: Pick<SessionsState, "runId" | "connection">,
  historyFailed: boolean | undefined,
): SessionsState["connection"] {
  if (runId === null) return "current";
  if (historyFailed === true) return "stale";
  return connection === "loading" ? "loading" : "current";
}
