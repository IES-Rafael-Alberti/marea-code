import * as z from "zod";

import { DashboardCursorSchema, RequestIdSchema, RunIdSchema } from "./identifiers.js";
import { UtcTimestampSchema } from "./runs.js";
import { SafeDisplayNameSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const ActiveRunDashboardQuerySchema = z
  .object({
    kind: z.literal("active-runs-query"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    cursor: DashboardCursorSchema.optional(),
    limit: z.number().int().min(1).max(100),
  })
  .strict()
  .readonly();

const ActiveRunDashboardItemSchema = z
  .object({
    runId: RunIdSchema,
    studentDisplayName: SafeDisplayNameSchema,
    classDisplayName: SafeDisplayNameSchema,
    projectDisplayName: SafeDisplayNameSchema,
    state: z.literal("active"),
    startedAt: UtcTimestampSchema,
    lastActivityAt: UtcTimestampSchema,
    highestDurableSequence: z.number().int().nonnegative(),
    pendingApproval: z.boolean(),
  })
  .strict()
  .refine(
    (run) => Date.parse(run.lastActivityAt) >= Date.parse(run.startedAt),
    "Run activity cannot predate its start.",
  )
  .readonly();

export const ActiveRunDashboardResponseSchema = z
  .object({
    kind: z.literal("active-runs-response"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    generatedAt: UtcTimestampSchema,
    viewer: z
      .object({ role: z.literal("teacher"), displayName: SafeDisplayNameSchema })
      .strict()
      .readonly(),
    runs: z
      .array(ActiveRunDashboardItemSchema)
      .max(100)
      .refine(
        (runs) => new Set(runs.map((run) => run.runId)).size === runs.length,
        "Dashboard run identifiers must be unique.",
      )
      .readonly(),
    nextCursor: DashboardCursorSchema.nullable(),
  })
  .strict()
  .readonly();

export type ActiveRunDashboardQuery = z.infer<typeof ActiveRunDashboardQuerySchema>;
export type ActiveRunDashboardResponse = z.infer<typeof ActiveRunDashboardResponseSchema>;
