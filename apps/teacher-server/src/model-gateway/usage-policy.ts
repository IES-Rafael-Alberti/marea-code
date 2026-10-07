import * as z from "zod";

import { UsagePolicySchema, type UsagePolicy } from "@marea/protocol";
export { UsagePolicySchema, type UsagePolicy };
const CountSchema = z.number().int().nonnegative();

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
  if (policy.unlimited === true) return { inputTokens: 0, outputTokens: 0, costUnits: 0 };
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
  if (policy.unlimited === true) return null;
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
