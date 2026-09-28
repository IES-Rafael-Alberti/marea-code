import * as z from "zod";

import {
  EventIdSchema,
  IdempotencyKeySchema,
  RequestIdSchema,
  RunIdSchema,
} from "./identifiers.js";
import { UtcTimestampSchema } from "./runs.js";
import { SafeDisplayNameSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

const envelope = { protocolVersion: CurrentProtocolVersionSchema, requestId: RequestIdSchema };
export const NoticeTextSchema = z.string().trim().min(1).max(16_384);

export const TeacherNoticeSchema = z
  .object({
    noticeId: EventIdSchema,
    runId: RunIdSchema,
    source: z.enum(["teacher-message", "approved-evaluation"]),
    teacherDisplayName: SafeDisplayNameSchema,
    text: NoticeTextSchema,
    createdAt: UtcTimestampSchema,
  })
  .strict()
  .readonly();

export const PublishTeacherNoticeRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-notice-publish"),
    idempotencyKey: IdempotencyKeySchema,
    runId: RunIdSchema,
    text: NoticeTextSchema,
  })
  .strict()
  .readonly();

export const PublishTeacherNoticeResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-notice-published"),
    notice: TeacherNoticeSchema,
  })
  .strict()
  .readonly();

export const PendingNoticesRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("pending-notices-query"),
    limit: z.number().int().min(1).max(32),
  })
  .strict()
  .readonly();

export const PendingNoticesResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("pending-notices-response"),
    notices: z.array(TeacherNoticeSchema).max(32).readonly(),
  })
  .strict()
  .readonly();

export const AcknowledgeNoticeRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-notice-acknowledge"),
    noticeId: EventIdSchema,
  })
  .strict()
  .readonly();

export const AcknowledgeNoticeResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-notice-acknowledged"),
    noticeId: EventIdSchema,
    acknowledgedAt: UtcTimestampSchema,
  })
  .strict()
  .readonly();

export type TeacherNotice = z.infer<typeof TeacherNoticeSchema>;
export type PublishTeacherNoticeRequest = z.infer<typeof PublishTeacherNoticeRequestSchema>;
export type PublishTeacherNoticeResponse = z.infer<typeof PublishTeacherNoticeResponseSchema>;
export type PendingNoticesRequest = z.infer<typeof PendingNoticesRequestSchema>;
export type PendingNoticesResponse = z.infer<typeof PendingNoticesResponseSchema>;
export type AcknowledgeNoticeRequest = z.infer<typeof AcknowledgeNoticeRequestSchema>;
export type AcknowledgeNoticeResponse = z.infer<typeof AcknowledgeNoticeResponseSchema>;

/** Readback of one publication, including a response lost before its ID was known. */
export const TeacherNoticeQuerySchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-notice-query"),
    runId: RunIdSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict()
  .readonly();
export const TeacherNoticeStatusSchema = z
  .object({
    notice: TeacherNoticeSchema,
    acknowledgedAt: UtcTimestampSchema.nullable(),
  })
  .strict()
  .readonly();
export const TeacherNoticeQueryResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-notice-status"),
    runId: RunIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    publication: TeacherNoticeStatusSchema.nullable(),
  })
  .strict()
  .readonly();
export type TeacherNoticeQuery = z.infer<typeof TeacherNoticeQuerySchema>;
export type TeacherNoticeStatus = z.infer<typeof TeacherNoticeStatusSchema>;
export type TeacherNoticeQueryResponse = z.infer<typeof TeacherNoticeQueryResponseSchema>;
