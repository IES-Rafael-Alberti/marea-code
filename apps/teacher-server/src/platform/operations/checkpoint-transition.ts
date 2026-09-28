import { IndexCheckpointSchema, type IndexCheckpoint } from "./schemas.js";

export type CheckpointEvent =
  | { readonly type: "index-prepared" }
  | { readonly type: "index-committed" }
  | { readonly type: "content-started" }
  | { readonly type: "mark-uncertain"; readonly committedTombstones?: boolean }
  | { readonly type: "content-complete" }
  /** Exact operator continuation of interrupted content removal after durable intent. */
  | { readonly type: "resume-content" }
  | { readonly type: "mark-failed"; readonly committedTombstones: boolean };

export interface CheckpointTransition {
  readonly state: "prepared" | "committed" | "failed" | "uncertain";
  readonly accepted: boolean;
  readonly canMarkFailed: boolean;
  readonly canRemoveContent: boolean;
  readonly durableIntent: "none" | "committed";
  readonly contentState: "pending" | "in-progress" | "complete";
}

function result(
  state: CheckpointTransition["state"],
  accepted: boolean,
  canMarkFailed: boolean,
  canRemoveContent: boolean,
  contentState: CheckpointTransition["contentState"],
  durableIntent: CheckpointTransition["durableIntent"],
): CheckpointTransition {
  return {
    state,
    accepted,
    canMarkFailed,
    canRemoveContent,
    durableIntent,
    contentState,
  };
}

function rejected(current: IndexCheckpoint): CheckpointTransition {
  return result("uncertain", false, false, false, current.contentState, current.durableIntent);
}

/** Only an uncertain checkpoint whose tombstones are durable may resume content removal. */
function resumeContent(current: IndexCheckpoint): CheckpointTransition {
  return current.state === "uncertain" && current.durableIntent === "committed"
    ? result("committed", true, false, true, "in-progress", "committed")
    : rejected(current);
}

export function transitionCheckpoint(
  checkpoint: IndexCheckpoint,
  event: CheckpointEvent,
): CheckpointTransition {
  const current = IndexCheckpointSchema.parse(checkpoint);
  const currentIntent = current.durableIntent;
  switch (event.type) {
    case "index-prepared":
      if (current.state === "prepared")
        return result("prepared", true, true, false, current.contentState, currentIntent);
      break;
    case "index-committed":
      if (current.state === "prepared")
        return result("committed", true, false, false, "pending", "committed");
      break;
    case "content-started":
      if (current.state === "committed" && current.contentState === "pending")
        return result("committed", true, false, true, "in-progress", "committed");
      break;
    case "mark-uncertain":
      if (current.state === "prepared" || current.state === "committed")
        return result(
          "uncertain",
          true,
          false,
          false,
          current.contentState,
          currentIntent === "committed" || event.committedTombstones === true
            ? "committed"
            : "none",
        );
      break;
    case "content-complete":
      if (current.state === "committed" && current.contentState === "in-progress")
        return result("committed", true, false, false, "complete", "committed");
      break;
    case "resume-content":
      return resumeContent(current);
    case "mark-failed":
      if (current.state === "prepared" && Object.is(event.committedTombstones, false))
        return result("failed", true, false, false, "pending", "none");
      break;
  }
  return rejected(current);
}

export function canMarkCheckpointFailed(
  checkpoint: IndexCheckpoint,
  committedTombstones: boolean,
): boolean {
  const parsed = IndexCheckpointSchema.parse(checkpoint);
  return parsed.state === "prepared" && Object.is(committedTombstones, false);
}
