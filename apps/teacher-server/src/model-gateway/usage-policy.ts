import * as z from "zod";

const CountSchema = z.number().int().nonnegative();

export const UsagePolicySchema = z
  .object({
    version: z.string().min(1).max(128),
    costUnit: z.string().min(1).max(64),
    inputCostUnitsPerToken: CountSchema,
    outputCostUnitsPerToken: CountSchema,
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
      BigInt(policy.maxInputTokens) + BigInt(policy.maxOutputTokens) <=
      BigInt(Number.MAX_SAFE_INTEGER),
    "A reservation must fit the exact token counter.",
  )
  .refine(
    (policy) =>
      BigInt(policy.maxInputTokens) * BigInt(policy.inputCostUnitsPerToken) +
        BigInt(policy.maxOutputTokens) * BigInt(policy.outputCostUnitsPerToken) <=
      BigInt(Number.MAX_SAFE_INTEGER),
    "A reservation must fit the exact cost counter.",
  )
  .readonly();

export type UsagePolicy = z.infer<typeof UsagePolicySchema>;

export const TokenUsageSchema = z
  .object({ inputTokens: CountSchema, outputTokens: CountSchema })
  .strict()
  .readonly();

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export interface UsageCharge extends TokenUsage {
  readonly costUnits: number;
}

export interface UsageTotals {
  readonly requests: number;
  readonly tokens: number;
  readonly costUnits: number;
  readonly inFlight: number;
}

export type AdmissionDenial = "requests" | "tokens" | "cost" | "concurrency";

export function reservedCharge(policy: UsagePolicy): UsageCharge {
  return chargeForUsage(policy, {
    inputTokens: policy.maxInputTokens,
    outputTokens: policy.maxOutputTokens,
  });
}

export function chargeForUsage(policy: UsagePolicy, usage: TokenUsage): UsageCharge {
  const cost =
    BigInt(usage.inputTokens) * BigInt(policy.inputCostUnitsPerToken) +
    BigInt(usage.outputTokens) * BigInt(policy.outputCostUnitsPerToken);
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Usage cost exceeds exact storage.");
  return { ...usage, costUnits: Number(cost) };
}

export function admissionDenial(policy: UsagePolicy, totals: UsageTotals): AdmissionDenial | null {
  if (totals.requests >= policy.maxRequests) return "requests";
  if (totals.inFlight >= policy.maxConcurrentRequests) return "concurrency";
  const charge = reservedCharge(policy);
  if (
    BigInt(totals.tokens) + BigInt(charge.inputTokens) + BigInt(charge.outputTokens) >
    BigInt(policy.maxTokens)
  )
    return "tokens";
  if (BigInt(totals.costUnits) + BigInt(charge.costUnits) > BigInt(policy.maxCostUnits))
    return "cost";
  return null;
}
