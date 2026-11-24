import * as z from "zod";

import { IdempotencyKeySchema, RequestIdSchema, RunIdSchema } from "./identifiers.js";
import { RevisionIdSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

const envelope = { protocolVersion: CurrentProtocolVersionSchema, requestId: RequestIdSchema };

export const MAX_CLASS_CLOSE_RUNS = 100;

/** A teacher ends one active student run. Repeating the request never fails or reopens it. */
export const TeacherRunCloseRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-run-close"),
    runId: RunIdSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict()
  .readonly();

/** A teacher ends the listed active runs of one class; only those runs are closed. */
export const ClassRunsCloseRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("class-runs-close"),
    classId: RevisionIdSchema,
    runIds: z
      .array(RunIdSchema)
      .min(1)
      .max(MAX_CLASS_CLOSE_RUNS)
      .refine((runIds) => new Set(runIds).size === runIds.length, "Run identifiers must be unique.")
      .readonly(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict()
  .readonly();

export const RunsCloseResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("runs-close-response"),
    /** Runs this request closed now. */
    closed: z.array(RunIdSchema).max(MAX_CLASS_CLOSE_RUNS).readonly(),
    /** Runs that were already closed, or no longer part of the class, and were left unchanged. */
    unchanged: z.array(RunIdSchema).max(MAX_CLASS_CLOSE_RUNS).readonly(),
  })
  .strict()
  .readonly();

export type TeacherRunCloseRequest = z.infer<typeof TeacherRunCloseRequestSchema>;
export type ClassRunsCloseRequest = z.infer<typeof ClassRunsCloseRequestSchema>;
export type RunsCloseResponse = z.infer<typeof RunsCloseResponseSchema>;
