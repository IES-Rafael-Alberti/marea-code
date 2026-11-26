import { RelativeWorkspacePathSchema } from "@marea/protocol";
import { describeIssues } from "@marea/deepagents-adapter";
import * as z from "zod";

/** Read tools expose virtual-root paths; events and approved effects use relative paths. */
export const WriteRequestSchema = z
  .object({
    content: z.string(),
    path: z
      .string()
      .transform((path) => path.replace(/^(?:\.\/|\/)/u, ""))
      .pipe(RelativeWorkspacePathSchema),
  })
  .strict()
  .readonly();

export type WriteRequest = z.infer<typeof WriteRequestSchema>;

/** Why the model's write_file arguments cannot be reviewed, or null when they can. */
export function writeRequestProblem(arguments_: Readonly<Record<string, string>>): string | null {
  const parsed = WriteRequestSchema.safeParse(arguments_);
  return parsed.success ? null : `The arguments are invalid: ${describeIssues(parsed.error)}`;
}
