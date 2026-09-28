import { z } from "zod";

import {
  AuthorityLineageSchema,
  IndexGenerationSchema,
  RootIdSchema,
} from "../operations/schemas.js";

/** The exact persisted handoff a continuation names; nothing else resumes a transfer. */
export function transferContinuationSchema() {
  return z
    .object({
      handoffId: z.string().min(1),
      authorityLineage: AuthorityLineageSchema,
      expectedIndexGeneration: IndexGenerationSchema,
      indexDigest: z.string().min(1),
      sourceRoot: RootIdSchema,
      destinationRoot: RootIdSchema,
    })
    .strict();
}
export type TransferContinuation = z.infer<ReturnType<typeof transferContinuationSchema>>;
