import * as z from "zod";

import {
  ClientSessionIdSchema,
  IdempotencyKeySchema,
  MessageIdSchema,
  RequestIdSchema,
  RunIdSchema,
  RunTokenSchema,
  SkillIdSchema,
  SnapshotIdSchema,
} from "./identifiers.js";
import { CurrentProtocolVersionSchema } from "./version.js";
import { RevisionIdSchema, SoftwareVersionSchema, ToolNameSchema } from "./technical.js";

const MAX_PROMPT_BYTES = 256 * 1_024;
const textEncoder = new TextEncoder();
const uniqueStrings = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const AgentModeSchema = z.enum(["tutoring", "free"]);
export const ModelAliasSchema = z.literal("marea");
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .brand<"Sha256Digest">();
// Stryker disable next-line ObjectLiteral: Zod's omitted offset option is also false.
export const UtcTimestampSchema = z.iso.datetime({ offset: false });

export function textDigestBytes(content: string): Uint8Array {
  return textEncoder.encode(content);
}

const ProjectDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._()'-]*$/u);

const ProjectSummarySchema = z
  .object({
    displayName: ProjectDisplayNameSchema,
  })
  .strict()
  .readonly();

const NewRunIntentSchema = z
  .object({ kind: z.literal("new") })
  .strict()
  .readonly();
const ResumeRunIntentSchema = z
  .object({ kind: z.literal("resume") })
  .strict()
  .readonly();

export const OpenRunRequestSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    clientVersion: SoftwareVersionSchema,
    requestId: RequestIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    clientSessionId: ClientSessionIdSchema,
    project: ProjectSummarySchema,
    runId: RunIdSchema.optional(),
    intent: z.discriminatedUnion("kind", [NewRunIntentSchema, ResumeRunIntentSchema]),
  })
  .strict()
  .refine(
    (request) => request.intent.kind === "resume" || request.runId === undefined,
    "A run identity may only accompany a resume intent.",
  )
  .readonly();

export const PromptSnapshotSchema = z
  .object({
    version: RevisionIdSchema,
    digest: Sha256DigestSchema,
    content: z
      .string()
      .min(1)
      .refine(
        (content) => textDigestBytes(content).byteLength <= MAX_PROMPT_BYTES,
        `Prompt content must be at most ${String(MAX_PROMPT_BYTES)} UTF-8 bytes.`,
      ),
  })
  .strict()
  .readonly();

const DidacticSkillReferenceSchema = z
  .object({
    id: SkillIdSchema,
    digest: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const TeacherToolRestrictionSchema = z
  .object({
    tool: ToolNameSchema,
    effect: z.enum(["require-approval", "deny"]),
  })
  .strict()
  .readonly();

export const TeacherToolPolicySchema = z
  .object({
    version: RevisionIdSchema,
    restrictions: z
      .array(TeacherToolRestrictionSchema)
      .max(128)
      .refine(
        (rules) => uniqueStrings(rules.map((rule) => rule.tool)),
        "Each tool may have at most one teacher restriction.",
      )
      .readonly(),
  })
  .strict()
  .readonly();

export const StudentRunSnapshotSchema = z
  .object({
    id: SnapshotIdSchema,
    agentMode: AgentModeSchema,
    modelAlias: ModelAliasSchema,
    prompt: PromptSnapshotSchema,
    /** Absent in immutable legacy snapshots and in free mode. */
    startup: PromptSnapshotSchema.optional(),
    didacticSkills: z
      .array(DidacticSkillReferenceSchema)
      .max(64)
      .refine(
        (skills) => uniqueStrings(skills.map((skill) => skill.id)),
        "Didactic skill identifiers must be unique.",
      )
      .readonly(),
    teacherToolPolicy: TeacherToolPolicySchema,
  })
  .strict()
  .readonly();

export const RunLeaseSchema = z
  .object({
    runId: RunIdSchema,
    token: RunTokenSchema,
    issuedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
  })
  .strict()
  .refine(
    (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.issuedAt),
    "Run lease must expire after issue.",
  )
  .readonly();

export const STARTUP_MESSAGE_ID = MessageIdSchema.parse("marea:tutor-startup");
export const RunStartupStateSchema = z.enum(["pending", "started", "completed", "cancelled"]);
export type RunStartupState = z.infer<typeof RunStartupStateSchema>;

export const OpenRunResponseSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    highestDurableSequence: z.number().int().nonnegative(),
    lease: RunLeaseSchema,
    snapshot: StudentRunSnapshotSchema,
    startupState: RunStartupStateSchema.optional(),
  })
  .strict()
  .readonly();

export const CloseRunReasonSchema = z.enum([
  "student-exit",
  "cancelled",
  "composition-failed",
  "fatal-error",
]);

export const CloseRunRequestSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    reason: CloseRunReasonSchema,
    runId: RunIdSchema.optional(),
  })
  .strict()
  .readonly();

export const CloseRunResponseSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    state: z.literal("closed"),
    alreadyClosed: z.boolean(),
  })
  .strict()
  .readonly();

export const RenewRunLeaseRequestSchema = z
  .object({
    kind: z.literal("run-lease-renewal"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    runId: RunIdSchema,
  })
  .strict()
  .readonly();

export const RenewRunLeaseResponseSchema = z
  .object({
    kind: z.literal("run-lease-renewed"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    lease: RunLeaseSchema,
  })
  .strict()
  .readonly();

export type AgentMode = z.infer<typeof AgentModeSchema>;
export type CloseRunRequest = z.infer<typeof CloseRunRequestSchema>;
export type CloseRunResponse = z.infer<typeof CloseRunResponseSchema>;
export type ModelAlias = z.infer<typeof ModelAliasSchema>;
export type OpenRunRequest = z.infer<typeof OpenRunRequestSchema>;
export type OpenRunResponse = z.infer<typeof OpenRunResponseSchema>;
export type RenewRunLeaseRequest = z.infer<typeof RenewRunLeaseRequestSchema>;
export type RenewRunLeaseResponse = z.infer<typeof RenewRunLeaseResponseSchema>;
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;
export type StudentRunSnapshot = z.infer<typeof StudentRunSnapshotSchema>;
