import type { InferenceProviderRequest } from "@marea/plugin-api";

import { UsagePolicySchema } from "../src/model-gateway/usage-policy.js";
import { RouteBudgetSchema } from "../src/model-gateway/route-policy.js";

export const USAGE_ACCOUNT = { runId: "run:a", purpose: "tutoring" as const };
export const USAGE_POLICY = UsagePolicySchema.parse({
  version: "synthetic:1",
  costUnit: "synthetic-unit",
  inputCostUnitsPerToken: 2,
  outputCostUnitsPerToken: 3,
  maxRequests: 3,
  maxTokens: 100,
  maxCostUnits: 250,
  maxConcurrentRequests: 1,
  maxRequestDurationMs: 1000,
  maxInputTokens: 10,
  maxOutputTokens: 10,
  maxToolCalls: 1,
});
export const USAGE_REQUEST: InferenceProviderRequest = {
  requestId: "request:usage",
  upstreamModel: "synthetic-private-model",
  messages: [{ role: "user", content: "Help." }],
  tools: [],
};

const acceptancePolicy = {
  ...USAGE_POLICY,
  maxInputTokens: 65_536,
  maxOutputTokens: 16_384,
  maxRequests: 1_000,
  maxTokens: 100_000_000,
  maxCostUnits: 1_000_000_000,
  maxConcurrentRequests: 4,
  maxToolCalls: 1_000,
  maxRequestDurationMs: 30_000,
};
export const SYNTHETIC_ROUTE_BUDGET = RouteBudgetSchema.parse({
  inputTokenCeiling: 65_536,
  tutoring: acceptancePolicy,
  evaluation: acceptancePolicy,
});
