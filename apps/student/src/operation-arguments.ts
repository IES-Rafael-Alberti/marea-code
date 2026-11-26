import { describeIssues } from "@marea/deepagents-adapter";
import * as z from "zod";

import type { OperationName } from "./operation-contracts.js";

export const EditSchema = z
  .object({
    path: z.string().min(1).max(512),
    old_string: z.string().min(1).max(65_536),
    new_string: z.string().max(65_536),
  })
  .strict();
export const DeleteSchema = z.object({ path: z.string().min(1).max(512) }).strict();
export const CommandSchema = z.object({ command: z.string().min(1).max(4096) }).strict();

function schemaFor(tool: OperationName) {
  if (tool === "execute") return CommandSchema;
  return tool === "delete" ? DeleteSchema : EditSchema;
}

/** Why the model's arguments for this operation cannot be reviewed, or null when they can. */
export function operationArgumentsProblem(
  tool: OperationName,
  arguments_: Readonly<Record<string, string>>,
): string | null {
  const parsed = schemaFor(tool).safeParse(arguments_);
  return parsed.success ? null : `The arguments are invalid: ${describeIssues(parsed.error)}`;
}
