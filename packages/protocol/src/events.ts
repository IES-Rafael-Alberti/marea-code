import * as z from "zod";

import {
  ApprovalIdSchema,
  EffectIdSchema,
  EventIdSchema,
  MessageIdSchema,
  RequestIdSchema,
} from "./identifiers.js";
import { CloseRunReasonSchema, Sha256DigestSchema, UtcTimestampSchema } from "./runs.js";
import { ToolNameSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const MAX_RUN_EVENTS_REQUEST_BYTES = 2 * 1_024 * 1_024;

const EventSequenceSchema = z.number().int().positive();
const EventTextSchema = z.string().min(1).max(65_536);
const ApprovalSummarySchema = z.string().min(1).max(2_048);
const RelativeWorkspacePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+)*$/u)
  .refine(
    (path) => path.split("/").every((segment) => segment !== "." && segment !== ".."),
    "Workspace event paths must stay relative to the project root.",
  );

const eventBaseShape = {
  eventId: EventIdSchema,
  sequence: EventSequenceSchema,
  occurredAt: UtcTimestampSchema,
};

const StudentMessageEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("student-message"),
    content: EventTextSchema,
    messageId: MessageIdSchema.optional(),
  })
  .strict()
  .readonly();

const AssistantMessageEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("assistant-message"),
    content: EventTextSchema,
    messageId: MessageIdSchema.optional(),
  })
  .strict()
  .readonly();

const ApprovalRequestedEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("approval-requested"),
    approvalId: ApprovalIdSchema,
    messageId: MessageIdSchema.optional(),
    tool: ToolNameSchema,
    summary: ApprovalSummarySchema,
    path: RelativeWorkspacePathSchema.optional(),
    content: z.string().max(65_536).optional(),
    truncated: z.boolean().optional(),
  })
  .strict()
  .readonly();

const ApprovalResolvedEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("approval-resolved"),
    approvalId: ApprovalIdSchema,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().max(4096).optional(),
    effectId: EffectIdSchema.optional(),
    messageId: MessageIdSchema.optional(),
  })
  .strict()
  .readonly();

const WorkspaceEditEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("workspace-edit"),
    approvalId: ApprovalIdSchema,
    effectId: EffectIdSchema.optional(),
    messageId: MessageIdSchema.optional(),
    operation: z.enum(["created", "updated"]),
    path: RelativeWorkspacePathSchema,
    digest: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const RunActivatedEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("run-activated"),
  })
  .strict()
  .readonly();

const RunClosedEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("run-closed"),
    reason: CloseRunReasonSchema,
  })
  .strict()
  .readonly();

export const CanonicalRunEventSchema = z.discriminatedUnion("eventType", [
  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("assistant-progress"),
      messageId: MessageIdSchema,
      content: z.string().max(16_384),
      truncated: z.boolean(),
    })
    .strict()
    .readonly(),

  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("model-diagnostic"),
      requestId: RequestIdSchema,
      phase: z.enum(["request", "response"]),
      status: z.enum(["started", "completed", "failed", "interrupted"]),
      content: z.string().max(16_384),
      truncated: z.boolean(),
    })
    .strict()
    .readonly(),

  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("project-context"),
      cwd: z.string().max(512),
      branch: z.string().max(128),
      repositoryUrl: z.string().max(256),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("project-change"),
      actor: z.enum(["student", "agent", "unknown"]),
      messageId: MessageIdSchema.optional(),
      patch: z.string().max(65_536),
      summary: z.string().max(4096),
      truncated: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("turn-ended"),
      messageId: MessageIdSchema,
      state: z.enum(["completed", "cancelled"]),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("turn-failed"),
      messageId: MessageIdSchema,
      category: z.string().min(1).max(128),
      retryable: z.boolean(),
    })
    .strict()
    .readonly(),

  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("tool-started"),
      // Cumulative tutor text before this call, including text omitted by live snapshots.
      assistantTextOffset: z.number().int().nonnegative().optional(),
      messageId: MessageIdSchema,
      callId: z.string().min(1).max(512),
      name: ToolNameSchema,
      target: z.string().max(2048),
      arguments: z.string().max(65_536),
      truncated: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("tool-finished"),
      messageId: MessageIdSchema,
      callId: z.string().min(1).max(512),
      failed: z.boolean(),
      result: z.string().max(65_536),
      truncated: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("questions-resolved"),
      messageId: MessageIdSchema,
      interruptId: z.string().min(1).max(512),
      questions: z
        .array(
          z
            .object({
              text: z.string().min(1).max(4096),
              choices: z.array(z.string().min(1).max(1024)).max(20).readonly(),
              required: z.boolean(),
            })
            .strict()
            .readonly(),
        )
        .min(1)
        .max(12)
        .readonly(),
      answers: z.array(z.string().max(4096)).max(12).readonly(),
      cancelled: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({ ...eventBaseShape, eventType: z.literal("internal-activity") })
    .strict()
    .readonly(),
  StudentMessageEventSchema,
  AssistantMessageEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  WorkspaceEditEventSchema,
  RunActivatedEventSchema,
  RunClosedEventSchema,
  z
    .object({
      ...eventBaseShape,
      eventType: z.literal("tutor-startup"),
      state: z.enum(["started", "completed", "cancelled"]),
    })
    .strict()
    .readonly(),
]);

function hasContiguousSequences(events: readonly CanonicalRunEvent[]): boolean {
  const firstSequence = events.reduce(
    (minimum, event) => Math.min(minimum, event.sequence),
    Number.MAX_SAFE_INTEGER,
  );
  return events.every((event, index) => event.sequence === firstSequence + index);
}

const CanonicalRunEventBatchSchema = z
  .array(CanonicalRunEventSchema)
  .min(1)
  .max(128)
  .refine(
    (events) => new Set(events.map((event) => event.eventId)).size === events.length,
    "Run event identifiers must be unique within a batch.",
  )
  .refine(hasContiguousSequences, "Run event sequences must be contiguous and ascending.")
  .readonly();

export const AppendRunEventsRequestSchema = z
  .object({
    kind: z.literal("run-events-append"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    events: CanonicalRunEventBatchSchema,
  })
  .strict()
  .readonly();

export const AppendRunEventsResponseSchema = z
  .object({
    kind: z.literal("run-events-acknowledged"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    highestDurableSequence: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export type AppendRunEventsRequest = z.infer<typeof AppendRunEventsRequestSchema>;
export type AppendRunEventsResponse = z.infer<typeof AppendRunEventsResponseSchema>;
export type CanonicalRunEvent = z.infer<typeof CanonicalRunEventSchema>;
