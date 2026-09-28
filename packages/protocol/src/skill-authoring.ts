import * as z from "zod";

import { RequestIdSchema, SkillIdSchema } from "./identifiers.js";
import { Sha256DigestSchema, textDigestBytes } from "./runs.js";
import { RevisionIdSchema } from "./technical.js";
import {
  isSkillFilePath,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  SkillBundleSchema,
} from "./teaching-skills.js";
import { CurrentProtocolVersionSchema } from "./version.js";

const envelope = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
  classId: RevisionIdSchema,
};

const skillFields = SkillBundleSchema.unwrap().shape;
const draftSlug = skillFields.name;

const draftFile = z
  .object({
    path: z.string().max(1_024).refine(isSkillFilePath, "Use a contained skill text-file path."),
    content: z
      .string()
      .refine((content) => content.isWellFormed(), "Skill text must be valid Unicode.")
      .refine((content) => !content.includes("\0"), "Skill text cannot contain NUL bytes.")
      .refine(
        (content) => textDigestBytes(content).byteLength <= MAX_SKILL_FILE_BYTES,
        "Skill file exceeds the byte limit.",
      ),
  })
  .strict()
  .readonly();

const draftFiles = z.array(draftFile).min(1).max(256).readonly();

/** Complete canonical source text; the server writer alone derives sizes, digests and identity. */
export const SkillAuthoringDraftSchema = z
  .object({ kind: z.enum(["didactic", "evaluation"]), slug: draftSlug, files: draftFiles })
  .strict()
  .refine(
    (draft) => draft.files.some((file) => file.path === "SKILL.md"),
    "A skill draft must contain SKILL.md.",
  )
  .refine(
    (draft) => new Set(draft.files.map((file) => file.path)).size === draft.files.length,
    "Skill file paths must be unique.",
  )
  .refine(
    (draft) =>
      draft.files.reduce((total, file) => total + textDigestBytes(file.content).byteLength, 0) <=
      MAX_SKILL_BUNDLE_BYTES,
    "Skill draft exceeds the bundle byte limit.",
  )
  .readonly();

export const SkillAuthoringReadTargetSchema = z.discriminatedUnion("scope", [
  z
    .object({ scope: z.literal("catalog"), skillId: SkillIdSchema })
    .strict()
    .readonly(),
  z
    .object({ scope: z.literal("personal"), slug: draftSlug })
    .strict()
    .readonly(),
]);

export const SkillAuthoringReadRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("skill-authoring-read"),
    target: SkillAuthoringReadTargetSchema,
  })
  .strict()
  .readonly();

export const SkillAuthoringValidateRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("skill-authoring-validate"),
    draft: SkillAuthoringDraftSchema,
  })
  .strict()
  .readonly();

export const SkillAuthoringSaveRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("skill-authoring-save"),
    draft: SkillAuthoringDraftSchema,
    expectedDigest: Sha256DigestSchema.nullable(),
  })
  .strict()
  .readonly();

export const SkillAuthoringCopyRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("skill-authoring-copy"),
    sourceSkillId: SkillIdSchema,
    sourceDigest: Sha256DigestSchema,
    slug: draftSlug,
  })
  .strict()
  .readonly();

export const SkillAuthoringReadResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("skill-authoring-read-result"),
    skill: SkillBundleSchema.nullable(),
    editable: z.boolean(),
  })
  .strict()
  .refine(
    (response) => response.skill !== null || !response.editable,
    "A missing skill cannot be editable.",
  )
  .readonly();

const personalSkill = SkillBundleSchema.refine(
  (skill) => skill.source === "teacher",
  "Authoring results must have teacher provenance.",
);

function personalResultSchema<const Kind extends SkillAuthoringResultKind>(kind: Kind) {
  return z
    .object({ ...envelope, kind: z.literal(kind), skill: personalSkill })
    .strict()
    .readonly();
}

export const SkillAuthoringValidateResponseSchema = personalResultSchema(
  "skill-authoring-validated",
);
export const SkillAuthoringSaveResponseSchema = personalResultSchema("skill-authoring-saved");
export const SkillAuthoringCopyResponseSchema = personalResultSchema("skill-authoring-copied");

export type SkillAuthoringResultKind =
  "skill-authoring-validated" | "skill-authoring-saved" | "skill-authoring-copied";
export type SkillAuthoringDraft = z.infer<typeof SkillAuthoringDraftSchema>;
export type SkillAuthoringReadTarget = z.infer<typeof SkillAuthoringReadTargetSchema>;
export type SkillAuthoringReadRequest = z.infer<typeof SkillAuthoringReadRequestSchema>;
export type SkillAuthoringValidateRequest = z.infer<typeof SkillAuthoringValidateRequestSchema>;
export type SkillAuthoringSaveRequest = z.infer<typeof SkillAuthoringSaveRequestSchema>;
export type SkillAuthoringCopyRequest = z.infer<typeof SkillAuthoringCopyRequestSchema>;
export type SkillAuthoringReadResponse = z.infer<typeof SkillAuthoringReadResponseSchema>;
export type SkillAuthoringValidateResponse = z.infer<typeof SkillAuthoringValidateResponseSchema>;
export type SkillAuthoringSaveResponse = z.infer<typeof SkillAuthoringSaveResponseSchema>;
export type SkillAuthoringCopyResponse = z.infer<typeof SkillAuthoringCopyResponseSchema>;
