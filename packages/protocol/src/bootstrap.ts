import * as z from "zod";

import { SafeStudentPrincipalSchema } from "./auth.js";
import { RequestIdSchema, RunIdSchema } from "./identifiers.js";
import { ModelAliasSchema } from "./runs.js";
import { RevisionIdSchema, SafeDisplayNameSchema } from "./technical.js";
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

export const MAX_SELECTABLE_CLASSES = 64;

/** A student session that may act for several classes names none until the student chooses. */
export const ClassSelectionRequiredResponseSchema = z
  .object({
    kind: z.literal("class-selection-required"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    principal: SafeStudentPrincipalSchema,
    classes: z
      .array(
        z
          .object({ classId: RevisionIdSchema, displayName: SafeDisplayNameSchema })
          .strict()
          .readonly(),
      )
      .min(1)
      .max(MAX_SELECTABLE_CLASSES)
      .refine(
        (classes) => new Set(classes.map((entry) => entry.classId)).size === classes.length,
        "Selectable classes must be unique.",
      )
      .readonly(),
  })
  .strict()
  .readonly();

export const ClassBootstrapOutcomeSchema = z.discriminatedUnion("kind", [
  ClassBootstrapResponseSchema,
  ClassSelectionRequiredResponseSchema,
]);

/** Binds a still unscoped student session to one of its active classes, once. */
export const ClassSelectRequestSchema = z
  .object({
    kind: z.literal("class-select"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    classId: RevisionIdSchema,
  })
  .strict()
  .readonly();

export type ClassBootstrapRequest = z.infer<typeof ClassBootstrapRequestSchema>;
export type ClassBootstrapResponse = z.infer<typeof ClassBootstrapResponseSchema>;
export type ClassSelectionRequiredResponse = z.infer<typeof ClassSelectionRequiredResponseSchema>;
export type ClassBootstrapOutcome = z.infer<typeof ClassBootstrapOutcomeSchema>;
export type ClassSelectRequest = z.infer<typeof ClassSelectRequestSchema>;
