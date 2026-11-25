import { ReadOnlyToolInputError, type ReadOnlyTool } from "@marea/deepagents-adapter";
import { WorkspaceError, type WorkspaceErrorCode } from "@marea/workspace-backend";
import * as z from "zod";

/** Outcomes the model can correct by choosing another path or argument; the turn continues. */
const CORRECTABLE: ReadonlySet<WorkspaceErrorCode> = new Set([
  "invalid-path",
  "not-found",
  "not-directory",
  "not-regular-file",
  "unsafe-entry",
  "read-limit-exceeded",
  "directory-limit-exceeded",
  "unsupported-text-encoding",
]);

function invalidArguments(error: z.ZodError): string {
  const issues = error.issues.map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
  );
  return `Invalid arguments (${issues.join("; ")}). Check the parameters in the tool description.`;
}

/**
 * A wrong argument or a missing path is an answer for the model, not a failed turn: it becomes a
 * tool error result. Filesystem failures and programming errors still propagate.
 */
export function withCorrectableErrors(tool: ReadOnlyTool): ReadOnlyTool {
  return {
    ...tool,
    execute: async (input) => {
      try {
        return await tool.execute(input);
      } catch (error) {
        if (error instanceof z.ZodError) throw new ReadOnlyToolInputError(invalidArguments(error));
        if (error instanceof WorkspaceError && CORRECTABLE.has(error.code)) {
          const path = typeof input.path === "string" ? ` (${input.path})` : "";
          throw new ReadOnlyToolInputError(`${error.message}${path}`);
        }
        throw error;
      }
    },
  };
}
