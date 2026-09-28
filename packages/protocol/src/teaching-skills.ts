import * as z from "zod";

import { RequestIdSchema, RunIdSchema, SkillIdSchema, SnapshotIdSchema } from "./identifiers.js";
import { Sha256DigestSchema, textDigestBytes } from "./runs.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const MAX_SKILL_FILE_BYTES = 512 * 1_024;
export const MAX_SKILL_BUNDLE_BYTES = 8 * 1_024 * 1_024;
/** Includes worst-case JSON escaping and bounded metadata, not additional skill content. */
export const MAX_SKILL_RESPONSE_BYTES = 64 * 1_024 * 1_024;

function isResourceSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !segment.startsWith(".") &&
    !segment.includes("\\") &&
    !/\p{Cc}/u.test(segment)
  );
}

export function isSkillFilePath(path: string): boolean {
  if (path === "SKILL.md") return true;
  const [root, ...segments] = path.split("/");
  return (
    root === "resources" &&
    segments.every(isResourceSegment) &&
    /\.(?:csv|json|md|txt|yaml|yml)$/iu.test(path)
  );
}

export const SkillFileSchema = z
  .object({
    path: z.string().max(1_024).refine(isSkillFilePath, "Use a contained skill text-file path."),
    content: z
      .string()
      .refine((content) => !content.includes("\0"), "Skill text cannot contain NUL bytes."),
    sizeBytes: z.number().int().min(0).max(MAX_SKILL_FILE_BYTES),
  })
  .strict()
  .refine(
    (file) => textDigestBytes(file.content).byteLength === file.sizeBytes,
    "Skill file size must match its UTF-8 content.",
  )
  .readonly();

const criterionLevel = z.string().min(1).max(1_024);
export const SkillCriterionSchema = z
  .object({
    code: z.string().min(1).max(64),
    statement: z.string().max(1_024),
    levels: z
      .tuple([criterionLevel, criterionLevel, criterionLevel, criterionLevel])
      .readonly()
      .nullable(),
  })
  .strict()
  .readonly();

export const SkillBundleSchema = z
  .object({
    id: SkillIdSchema,
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().min(1).max(1_024),
    kind: z.enum(["didactic", "evaluation"]),
    source: z.enum(["marea", "teacher", "center"]),
    digest: Sha256DigestSchema,
    license: z.string().max(MAX_SKILL_FILE_BYTES).nullable(),
    compatibility: z.string().max(500).nullable(),
    criteria: z.array(SkillCriterionSchema).max(64).readonly(),
    files: z.array(SkillFileSchema).min(1).max(256).readonly(),
  })
  .strict()
  .refine(
    (bundle) => bundle.id.startsWith(`${bundle.source}/`) && bundle.id.endsWith(`/${bundle.name}`),
    "Skill metadata must match its source identity.",
  )
  .refine(
    (bundle) => bundle.kind === "didactic" || bundle.criteria.length === 0,
    "Only didactic skills define learning criteria.",
  )
  .refine(
    (bundle) =>
      new Set(bundle.criteria.map((criterion) => criterion.code)).size === bundle.criteria.length,
    "Skill criterion codes must be unique.",
  )
  .refine(
    (bundle) => bundle.files.some((file) => file.path === "SKILL.md"),
    "A skill must contain SKILL.md.",
  )
  .refine(
    (bundle) => new Set(bundle.files.map((file) => file.path)).size === bundle.files.length,
    "Skill file paths must be unique.",
  )
  .refine(
    (bundle) =>
      bundle.files.reduce((total, file) => total + file.sizeBytes, 0) <= MAX_SKILL_BUNDLE_BYTES,
    "Skill bundle exceeds the byte limit.",
  )
  .readonly();

/** A single bundle per request bounds delivery; authorization is by run lease. */
export const RunSkillRequestSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    snapshotId: SnapshotIdSchema,
    skillId: SkillIdSchema,
  })
  .strict()
  .readonly();

export const RunSkillResponseSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    snapshotId: SnapshotIdSchema,
    skill: SkillBundleSchema.refine(
      (skill) => skill.kind === "didactic",
      "Evaluation skills cannot be delivered to students.",
    ),
  })
  .strict()
  .readonly();

export type RunSkillRequest = z.infer<typeof RunSkillRequestSchema>;
export type RunSkillResponse = z.infer<typeof RunSkillResponseSchema>;
