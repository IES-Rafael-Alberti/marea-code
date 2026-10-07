import * as z from "zod";
import { ReportSynthesisSchema, EvaluationDraftSchema } from "@marea/protocol";
export const budgetSchema = z.object({
  requests: z.number(),
  tokens: z.number(),
  costUnits: z.number(),
  maxRequests: z.number().nullable(),
  maxTokens: z.number().nullable(),
  maxCostUnits: z.number().nullable(),
  costUnit: z.string(),
});
export const mapSchema = z.object({
  budget: budgetSchema.nullable().optional(),
  enabled: z.boolean(),
  configured: z.boolean(),
  entries: z.array(
    z.object({
      runId: z.string(),
      student: z.string(),
      project: z.string(),
      state: z.enum(["green", "yellow", "red", "error", "disabled", "disconnected", "pending"]),
      reason: z.string(),
      confidence: z.enum(["low", "medium", "high"]),
      analyzedAt: z.string().nullable(),
    }),
  ),
});
export const progressSchema = z.object({
  revision: z.string(),
  entries: z.array(
    z.object({
      key: z.string(),
      skillId: z.string(),
      code: z.string(),
      statement: z.string(),
      level: z.number(),
      levels: z.array(z.string()).length(4),
      epoch: z.number(),
    }),
  ),
});
export const overviewSchema = z.object({
  students: z.array(progressSchema.extend({ id: z.string(), displayName: z.string() })),
  next: z.string().nullable(),
});
export const reportSchema = z.object({
  budget: budgetSchema.nullable().optional(),
  students: z.array(z.object({ alias: z.string(), displayName: z.string() })).default([]),
  id: z.string(),
  state: z.string(),
  from: z.string(),
  to: z.string(),
  completed: z.number(),
  total: z.number(),
  result: z
    .object({
      partial: z.boolean(),
      synthesis: ReportSynthesisSchema,
      evidence: z.array(
        z.object({
          runId: z.string(),
          alias: z.string(),
          mode: z.string(),
          status: z.enum(["approved", "provisional", "unavailable"]),
          evaluation: EvaluationDraftSchema.nullable(),
        }),
      ),
    })
    .nullable(),
});
export const reportsSchema = z.object({
  configured: z.boolean(),
  entries: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      createdAt: z.string(),
      from: z.string(),
      to: z.string(),
      completed: z.number(),
      total: z.number(),
    }),
  ),
});
export const historySchema = z.object({
  entries: z.array(
    z.object({
      id: z.number(),
      runId: z.string().nullable(),
      previousLevel: z.number(),
      level: z.number(),
      reason: z.string(),
      actor: z.string(),
      createdAt: z.string(),
    }),
  ),
});
