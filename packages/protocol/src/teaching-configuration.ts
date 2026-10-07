import * as z from "zod";

import { RequestIdSchema, SkillIdSchema } from "./identifiers.js";
import { AgentModeSchema, Sha256DigestSchema, SocraticModeSchema } from "./runs.js";
import { RevisionIdSchema, SafeDisplayNameSchema } from "./technical.js";
import { SkillBundleSchema } from "./teaching-skills.js";
import { CurrentProtocolVersionSchema } from "./version.js";

/** Covers two maximally JSON-escaped instruction fields plus bounded references. */
export const MAX_TEACHING_CONFIGURATION_BYTES = 4 * 1_024 * 1_024;
export const TEACHING_CATALOG_PAGE_SIZE = 100;

const envelope = { protocolVersion: CurrentProtocolVersionSchema, requestId: RequestIdSchema };
const selectedRevision = z
  .object({ id: SkillIdSchema, digest: Sha256DigestSchema })
  .strict()
  .readonly();

export const TeachingSelectionSchema = z
  .object({
    didactic: z.array(selectedRevision).max(64).readonly(),
    evaluation: z.array(selectedRevision).max(1).readonly(),
  })
  .strict()
  .refine((selection) => {
    const revisions = [...selection.didactic, ...selection.evaluation];
    return new Set(revisions.map(({ id }) => id)).size === revisions.length;
  }, "Selected skill identities must be unique.")
  .readonly();

export const ClassInstructionsSchema = z
  .object({
    tutoring: z.string().max(262_144),
    free: z.string().max(262_144),
    /** Absent in legacy records, whose text supplements the packaged mode. */
    format: z.literal("complete-mode").optional(),
  })
  .strict()
  .refine(
    (instructions) =>
      instructions.format === undefined ||
      (instructions.tutoring.length > 0 && instructions.free.length > 0),
    "Complete mode instructions must not be empty.",
  )
  .readonly();

/** Teacher-editable fields only; route, budget and tool authority remain server-owned. */
export const TeachingSettingsSchema = z
  .object({
    agentMode: AgentModeSchema,
    socraticMode: SocraticModeSchema.optional(),
    classInstructions: ClassInstructionsSchema,
    selection: TeachingSelectionSchema,
    automaticEvaluation: z.boolean(),
  })
  .strict()
  .refine(
    (settings) => !settings.automaticEvaluation || settings.selection.evaluation.length === 1,
    "Automatic evaluation requires a selected evaluation skill.",
  )
  .readonly();

export const TeachingClassSummarySchema = z
  .object({ classId: RevisionIdSchema, displayName: SafeDisplayNameSchema })
  .strict()
  .readonly();

/** Deliberately excludes files, license text and private evaluation content. */
const skillFields = SkillBundleSchema.unwrap().shape;
export const TeachingCatalogEntrySchema = z
  .object({
    id: skillFields.id,
    name: skillFields.name,
    description: skillFields.description,
    kind: skillFields.kind,
    source: skillFields.source,
    digest: skillFields.digest,
    compatibility: skillFields.compatibility,
  })
  .strict()
  .readonly();

export const TeachingConfigurationSchema = z
  .object({ version: RevisionIdSchema, settings: TeachingSettingsSchema })
  .strict()
  .readonly();

export const TeachingClassesQuerySchema = z
  .object({
    ...envelope,
    kind: z.literal("teaching-classes-query"),
    afterClassId: RevisionIdSchema.nullable(),
  })
  .strict()
  .readonly();

export const TeachingClassesResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("teaching-classes-response"),
    classes: z.array(TeachingClassSummarySchema).max(TEACHING_CATALOG_PAGE_SIZE).readonly(),
    nextAfterClassId: RevisionIdSchema.nullable(),
  })
  .strict()
  .readonly();

export const TeachingConfigurationQuerySchema = z
  .object({
    ...envelope,
    kind: z.literal("teaching-configuration-query"),
    classId: RevisionIdSchema,
  })
  .strict()
  .readonly();

export const TeachingConfigurationResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("teaching-configuration-response"),
    classId: RevisionIdSchema,
    configuration: TeachingConfigurationSchema.nullable(),
    operatorReady: z.boolean(),
  })
  .strict()
  .readonly();

export const TeachingCatalogQuerySchema = z
  .object({
    ...envelope,
    kind: z.literal("teaching-catalog-query"),
    classId: RevisionIdSchema,
    afterSkillId: SkillIdSchema.nullable(),
  })
  .strict()
  .readonly();

export const TeachingCatalogResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("teaching-catalog-response"),
    classId: RevisionIdSchema,
    skills: z.array(TeachingCatalogEntrySchema).max(TEACHING_CATALOG_PAGE_SIZE).readonly(),
    nextAfterSkillId: SkillIdSchema.nullable(),
  })
  .strict()
  .readonly();

export const SaveTeachingConfigurationRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("teaching-configuration-save"),
    classId: RevisionIdSchema,
    expectedVersion: RevisionIdSchema.nullable(),
    settings: TeachingSettingsSchema,
  })
  .strict()
  .readonly();

export const SaveTeachingConfigurationResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("teaching-configuration-saved"),
    classId: RevisionIdSchema,
    configuration: TeachingConfigurationSchema,
  })
  .strict()
  .readonly();

export type TeachingSelection = z.infer<typeof TeachingSelectionSchema>;
export type ClassInstructions = z.infer<typeof ClassInstructionsSchema>;
export type TeachingSettings = z.infer<typeof TeachingSettingsSchema>;
export type TeachingClassSummary = z.infer<typeof TeachingClassSummarySchema>;
export type TeachingCatalogEntry = z.infer<typeof TeachingCatalogEntrySchema>;
export type TeachingConfiguration = z.infer<typeof TeachingConfigurationSchema>;
export type TeachingClassesQuery = z.infer<typeof TeachingClassesQuerySchema>;
export type TeachingClassesResponse = z.infer<typeof TeachingClassesResponseSchema>;
export type TeachingConfigurationQuery = z.infer<typeof TeachingConfigurationQuerySchema>;
export type TeachingConfigurationResponse = z.infer<typeof TeachingConfigurationResponseSchema>;
export type TeachingCatalogQuery = z.infer<typeof TeachingCatalogQuerySchema>;
export type TeachingCatalogResponse = z.infer<typeof TeachingCatalogResponseSchema>;
export type SaveTeachingConfigurationRequest = z.infer<
  typeof SaveTeachingConfigurationRequestSchema
>;
export type SaveTeachingConfigurationResponse = z.infer<
  typeof SaveTeachingConfigurationResponseSchema
>;
