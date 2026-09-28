import * as z from "zod";

import { CanonicalRunEventSchema } from "./events.js";
import { RequestIdSchema, RunIdSchema } from "./identifiers.js";
import { StudentRunSnapshotSchema, UtcTimestampSchema } from "./runs.js";
import { RevisionIdSchema, SafeDisplayNameSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

const sequence = z.number().int().nonnegative();
const envelope = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
};

export const RunHistoryQuerySchema = z
  .object({
    ...envelope,
    kind: z.literal("run-history-query"),
    runId: RunIdSchema,
    afterSequence: sequence,
    throughSequence: sequence.optional(),
    limit: z.number().int().min(1).max(32),
  })
  .strict()
  .refine(
    (query) => query.throughSequence === undefined || query.afterSequence <= query.throughSequence,
    "History cursor cannot exceed its captured boundary.",
  )
  .readonly();

export const RunHistoryResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("run-history-response"),
    runId: RunIdSchema,
    snapshot: StudentRunSnapshotSchema,
    state: z.enum(["active", "closed"]),
    afterSequence: sequence,
    throughSequence: sequence,
    nextSequence: sequence.nullable(),
    events: z.array(CanonicalRunEventSchema).max(32).readonly(),
  })
  .strict()
  .refine(
    (page) =>
      page.events.every((event, index) => event.sequence === page.afterSequence + index + 1) &&
      (page.nextSequence === null
        ? page.afterSequence + page.events.length === page.throughSequence
        : page.events.length > 0 &&
          page.nextSequence === page.afterSequence + page.events.length &&
          page.nextSequence < page.throughSequence),
    "History pages must be contiguous within their captured boundary.",
  )
  .readonly();

export const SessionHistoryQuerySchema = z
  .object({
    ...envelope,
    kind: z.literal("session-history-query"),
    classId: RevisionIdSchema.optional(),
    beforeRunId: RunIdSchema.optional(),
    limit: z.number().int().min(1).max(50),
  })
  .strict()
  .readonly();

export const SessionHistoryItemSchema = z
  .object({
    runId: RunIdSchema,
    studentDisplayName: SafeDisplayNameSchema,
    classDisplayName: SafeDisplayNameSchema,
    projectDisplayName: SafeDisplayNameSchema,
    state: z.enum(["active", "closed"]),
    openedAt: UtcTimestampSchema,
    closedAt: UtcTimestampSchema.nullable(),
  })
  .strict()
  .readonly();

export const SessionHistoryResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("session-history-response"),
    runs: z.array(SessionHistoryItemSchema).max(50).readonly(),
    nextBeforeRunId: RunIdSchema.nullable(),
  })
  .strict()
  .readonly();

export type RunHistoryQuery = z.infer<typeof RunHistoryQuerySchema>;
export type RunHistoryResponse = z.infer<typeof RunHistoryResponseSchema>;
export type SessionHistoryQuery = z.infer<typeof SessionHistoryQuerySchema>;
export type SessionHistoryItem = z.infer<typeof SessionHistoryItemSchema>;
export type SessionHistoryResponse = z.infer<typeof SessionHistoryResponseSchema>;
