import * as z from "zod";
import { RequestIdSchema, SkillIdSchema } from "./identifiers.js";
import { RevisionIdSchema, SafeDisplayNameSchema } from "./technical.js";
import { Sha256DigestSchema } from "./runs.js";
import { CurrentProtocolVersionSchema } from "./version.js";
import { TeachingSelectionSchema, TeachingCatalogEntrySchema } from "./teaching-configuration.js";

export const SKILL_WORKSPACE_PATH = "/api/v1/dashboard/skill-workspace";
const selection = TeachingSelectionSchema.unwrap().shape.didactic.refine(
  (items) => new Set(items.map((item) => item.id)).size === items.length,
);
const envelope = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
  classId: RevisionIdSchema,
};
const target = z
  .object({ studentId: RevisionIdSchema, expectedVersion: RevisionIdSchema.nullable() })
  .strict();
export const SkillWorkspaceRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("library"), after: SkillIdSchema.nullable() }).strict(),
  z
    .object({ ...envelope, kind: z.literal("students"), after: RevisionIdSchema.nullable() })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("assign"),
      students: z
        .array(target)
        .min(1)
        .max(100)
        .refine((items) => new Set(items.map((item) => item.studentId)).size === items.length),
      expectedClassVersion: RevisionIdSchema,
      selection: selection.nullable(),
    })
    .strict(),
  z.object({ ...envelope, kind: z.literal("usage"), skillId: SkillIdSchema }).strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("apply"),
      skillId: SkillIdSchema,
      digest: Sha256DigestSchema,
      expectedUsage: Sha256DigestSchema,
    })
    .strict(),
]);
export const SkillWorkspaceStudentSchema = z
  .object({
    studentId: RevisionIdSchema,
    displayName: SafeDisplayNameSchema,
    version: RevisionIdSchema.nullable(),
    selection: selection.nullable(),
  })
  .strict();
export const SkillWorkspaceUsageSchema = z
  .object({
    classId: RevisionIdSchema,
    displayName: SafeDisplayNameSchema,
    classroom: z.boolean(),
    students: z.number().int().min(0),
  })
  .strict();
export const SkillLibraryEntrySchema = TeachingCatalogEntrySchema.unwrap()
  .extend({ title: z.string().min(1).max(256) })
  .strict();
export type SkillLibraryEntry = z.infer<typeof SkillLibraryEntrySchema>;
export const SkillWorkspaceResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...envelope,
      kind: z.literal("library"),
      skills: z.array(SkillLibraryEntrySchema).max(100),
      next: SkillIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("students"),
      students: z.array(SkillWorkspaceStudentSchema).max(100),
      next: RevisionIdSchema.nullable(),
    })
    .strict(),
  z.object({ ...envelope, kind: z.literal("assigned") }).strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("usage"),
      version: Sha256DigestSchema,
      uses: z.array(SkillWorkspaceUsageSchema),
    })
    .strict(),
  z.object({ ...envelope, kind: z.literal("applied") }).strict(),
]);
export type SkillWorkspaceRequest = z.infer<typeof SkillWorkspaceRequestSchema>;
export type SkillWorkspaceResponse = z.infer<typeof SkillWorkspaceResponseSchema>;
export type SkillWorkspaceStudent = z.infer<typeof SkillWorkspaceStudentSchema>;
export type SkillWorkspaceUsage = Extract<SkillWorkspaceResponse, { kind: "usage" }>;
