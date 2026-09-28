import * as z from "zod";

import { SafeStudentPrincipalSchema } from "./auth.js";
import { RequestIdSchema, RunIdSchema } from "./identifiers.js";
import { ModelAliasSchema } from "./runs.js";
import { SafeDisplayNameSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const ClassBootstrapRequestSchema = z
  .object({
    kind: z.literal("class-bootstrap"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
  })
  .strict()
  .readonly();

const ActiveStudentRunSchema = z
  .object({
    runId: RunIdSchema,
    projectDisplayName: SafeDisplayNameSchema,
    state: z.literal("active"),
  })
  .strict()
  .readonly();

export const ClassBootstrapResponseSchema = z
  .object({
    kind: z.literal("class-bootstrapped"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    principal: SafeStudentPrincipalSchema,
    classroom: z.object({ displayName: SafeDisplayNameSchema }).strict().readonly(),
    modelAlias: ModelAliasSchema,
    activeRun: ActiveStudentRunSchema.nullable(),
  })
  .strict()
  .readonly();

export type ClassBootstrapRequest = z.infer<typeof ClassBootstrapRequestSchema>;
export type ClassBootstrapResponse = z.infer<typeof ClassBootstrapResponseSchema>;
