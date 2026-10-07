import * as z from "zod";
import { UsagePolicySchema } from "../model-gateway/usage-policy.js";
export const EducationalRouteSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    budget: UsagePolicySchema,
    inputTokenCeiling: z.number().int().positive(),
  })
  .strict()
  .refine(
    (route) =>
      route.budget.unlimited === true || route.inputTokenCeiling <= route.budget.maxInputTokens,
    "The route input ceiling must fit the budget",
  );
export const EducationalConfigurationSchema = z
  .object({ map: EducationalRouteSchema.optional(), reports: EducationalRouteSchema.optional() })
  .strict();
export type EducationalConfiguration = z.infer<typeof EducationalConfigurationSchema>;
export type EducationalRoute = z.infer<typeof EducationalRouteSchema>;
