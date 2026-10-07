import * as z from "zod";

import { UsagePolicySchema } from "./inference-budget.js";

export const RouteBudgetSchema = z
  .object({
    inputTokenCeiling: z.number().int().positive(),
    tutoring: UsagePolicySchema,
    evaluation: UsagePolicySchema,
  })
  .strict()
  .refine(
    (budget) =>
      (budget.tutoring.unlimited === true ||
        budget.inputTokenCeiling <= budget.tutoring.maxInputTokens) &&
      (budget.evaluation.unlimited === true ||
        budget.inputTokenCeiling <= budget.evaluation.maxInputTokens),
    "Both budgets must reserve the complete captured route input ceiling.",
  )
  .readonly();

export const PrivateProviderRouteSchema = z
  .object({
    evaluation: z
      .object({ providerId: z.string().min(1), model: z.string().min(1) })
      .strict()
      .optional(),
    model: z.string().min(1),
    providerId: z.string().min(1),
    // Released legacy snapshots remain readable, but cannot admit unbudgeted inference.
    budget: RouteBudgetSchema.optional(),
  })
  .strict()
  .readonly();

export type PrivateProviderRoute = z.infer<typeof PrivateProviderRouteSchema>;
