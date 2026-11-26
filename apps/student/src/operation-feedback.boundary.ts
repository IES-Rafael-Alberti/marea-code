import { describeIssues } from "@marea/deepagents-adapter";
import { WorkspaceError, type WorkspaceErrorCode } from "@marea/workspace-backend";
import { ZodError } from "zod";

import { StaleReviewError } from "./workspace-writer.js";

/** A refusal the model can act on: the request cannot be applied as written. */
export class OperationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationRejectedError";
  }
}

/** Workspace failures caused by what the model asked for, not by the machine. */
const REQUEST_CODES: ReadonlySet<WorkspaceErrorCode> = new Set([
  "invalid-path",
  "not-found",
  "already-exists",
  "not-directory",
  "directory-not-empty",
  "not-regular-file",
  "unsafe-entry",
  "read-limit-exceeded",
  "write-limit-exceeded",
  "edit-conflict",
  "unsupported-text-encoding",
]);

/**
 * What the model should be told about a failed operation, or null when the failure is the
 * machine's (disk, permissions) and must still fail the turn.
 */
export function modelFeedback(error: unknown): string | null {
  if (error instanceof OperationRejectedError || error instanceof StaleReviewError)
    return error.message;
  if (error instanceof ZodError) return `The arguments are invalid: ${describeIssues(error)}`;
  if (error instanceof WorkspaceError && REQUEST_CODES.has(error.code))
    return `${error.message} (${error.code}). Check the path with the read tools.`;
  return null;
}
