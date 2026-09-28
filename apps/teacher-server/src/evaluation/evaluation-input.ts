import { createHash } from "node:crypto";

import {
  CanonicalRunEventSchema,
  RunIdSchema,
  Sha256DigestSchema,
  SkillIdSchema,
  SnapshotIdSchema,
} from "@marea/protocol";
import * as z from "zod";

import { PrivateProviderRouteSchema } from "../model-gateway/route-policy.js";
import { TeachingSnapshotContentSchema } from "../teaching/configuration/configuration-schema.js";

export const MAX_EVALUATION_INPUT_BYTES = 8 * 1_024 * 1_024;
const reference = z.object({ id: SkillIdSchema, digest: Sha256DigestSchema }).strict().readonly();

/** Null content records a bounded failed capture, never truncated material for inference. */
export const EvaluationInputSchema = z
  .object({
    format: z.literal("marea-evaluation-input:1"),
    runId: RunIdSchema,
    snapshotId: SnapshotIdSchema,
    mode: z.enum(["tutoring", "free"]),
    evaluator: reference,
    didacticSkills: z.array(reference).max(64).readonly(),
    content: z
      .object({
        teaching: TeachingSnapshotContentSchema,
        providerRoute: PrivateProviderRouteSchema,
        events: z.array(CanonicalRunEventSchema).min(2).readonly(),
      })
      .strict()
      .readonly()
      .nullable(),
  })
  .strict()
  .readonly();

export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;

export function evaluationDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
