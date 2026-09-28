// Match downstream v4 imports so compiled bundles initialize the shared constructors.
import * as z from "zod/v4";

const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const ClientSessionIdSchema = opaqueId.brand<"ClientSessionId">();
export const ApprovalIdSchema = opaqueId.brand<"ApprovalId">();
export const EventIdSchema = opaqueId.brand<"EventId">();
export const EvaluationIdSchema = opaqueId.brand<"EvaluationId">();
export const EffectIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .brand<"EffectId">();
export const IdempotencyKeySchema = opaqueId.brand<"IdempotencyKey">();
export const MessageIdSchema = opaqueId.brand<"MessageId">();
export const RequestIdSchema = opaqueId.brand<"RequestId">();
export const RunIdSchema = opaqueId.brand<"RunId">();
export const SnapshotIdSchema = opaqueId.brand<"SnapshotId">();
export const ToolCallIdSchema = opaqueId.brand<"ToolCallId">();

const secretToken = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const RunTokenSchema = secretToken.brand<"RunToken">();
export const SessionTokenSchema = secretToken.brand<"SessionToken">();
export const InvitationCodeSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"InvitationCode">();
export const DashboardCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"DashboardCursor">();

const MAX_SKILL_SLUG_LENGTH = 64;
const skillSlug = `(?=.{1,${String(MAX_SKILL_SLUG_LENGTH)}}$)[a-z0-9]+(?:-[a-z0-9]+)*`;
const sourceId = "[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?";
const skillIdPattern = new RegExp(
  `^(?:marea/${skillSlug}|(?:teacher|center)/${sourceId}/${skillSlug})$`,
);

export const SkillIdSchema = z.string().regex(skillIdPattern).brand<"SkillId">();

export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type ClientSessionId = z.infer<typeof ClientSessionIdSchema>;
export type DashboardCursor = z.infer<typeof DashboardCursorSchema>;
export type EffectId = z.infer<typeof EffectIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type EvaluationId = z.infer<typeof EvaluationIdSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type InvitationCode = z.infer<typeof InvitationCodeSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type RunToken = z.infer<typeof RunTokenSchema>;
export type SessionToken = z.infer<typeof SessionTokenSchema>;
export type SkillId = z.infer<typeof SkillIdSchema>;
export type SnapshotId = z.infer<typeof SnapshotIdSchema>;
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;
