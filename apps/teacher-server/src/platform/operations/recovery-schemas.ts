import * as z from "zod";
import { RevisionIdSchema, Sha256DigestSchema, UtcTimestampSchema } from "@marea/protocol";

import {
  AbsolutePathSchema,
  AuthorityLineageSchema,
  BootstrapContinuationSchema,
  HandoffRetirementSchema,
  MarkerOnlyRetirementSchema,
  IndexGenerationSchema,
} from "./schemas.js";

const RetireRootInputSchema = z.union([
  MarkerOnlyRetirementSchema.extend({ action: z.literal("retire-root") }),
  HandoffRetirementSchema.extend({ action: z.literal("retire-root") }),
]);

export const RecoveryInputSchema = z.union([
  z.object({ action: z.literal("inspect"), operationId: RevisionIdSchema.optional() }).strict(),
  z
    .object({
      action: z.literal("continue-exact"),
      operationId: RevisionIdSchema,
      authorityLineage: AuthorityLineageSchema,
      expectedIndexGeneration: IndexGenerationSchema,
      artifactDigest: Sha256DigestSchema,
      drainUntil: UtcTimestampSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("mark-failed"),
      operationId: RevisionIdSchema,
      authorityLineage: AuthorityLineageSchema,
      expectedIndexGeneration: IndexGenerationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("transfer-continue"),
      handoffId: RevisionIdSchema,
      authorityLineage: AuthorityLineageSchema,
      expectedIndexGeneration: IndexGenerationSchema,
      indexDigest: Sha256DigestSchema,
      sourceRoot: AbsolutePathSchema,
      destinationRoot: AbsolutePathSchema,
    })
    .strict(),
  RetireRootInputSchema,
  BootstrapContinuationSchema,
]);
export type RecoveryInput = z.infer<typeof RecoveryInputSchema>;
