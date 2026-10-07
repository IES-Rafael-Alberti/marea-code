import { RelativeWorkspacePathSchema } from "@marea/protocol";
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
