import * as z from "zod";

const CountSchema = z.number().int().nonnegative();

export const UsagePolicySchema = z
  .object({
    version: z.string().min(1).max(128),
    costUnit: z.string().min(1).max(64),
    inputCostUnitsPerToken: CountSchema,
    outputCostUnitsPerToken: CountSchema,
    /** Server-owned choice. Numeric ceilings are retained for switching limits back on. */
    unlimited: z.boolean().optional(),
    maxRequests: CountSchema,
    maxTokens: CountSchema,
    maxCostUnits: CountSchema,
    maxConcurrentRequests: z.number().int().positive(),
    maxRequestDurationMs: z.number().int().positive().max(2_147_483_647),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxToolCalls: CountSchema,
  })
  .strict()
  .refine(
    (policy) =>
      policy.unlimited === true ||
      BigInt(policy.maxInputTokens) + BigInt(policy.maxOutputTokens) <=
        BigInt(Number.MAX_SAFE_INTEGER),
    "A reservation must fit the exact token counter.",
  )
  .refine(
    (policy) =>
      policy.unlimited === true ||
      BigInt(policy.maxInputTokens) * BigInt(policy.inputCostUnitsPerToken) +
        BigInt(policy.maxOutputTokens) * BigInt(policy.outputCostUnitsPerToken) <=
        BigInt(Number.MAX_SAFE_INTEGER),
    "A reservation must fit the exact cost counter.",
  )
  .readonly();

export type UsagePolicy = z.infer<typeof UsagePolicySchema>;
