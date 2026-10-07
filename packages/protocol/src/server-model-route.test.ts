import { describe, expect, it } from "vitest";

import { UsagePolicySchema } from "./inference-budget.js";
import { PrivateProviderRouteSchema, RouteBudgetSchema } from "./server-model-route.js";

const policy = UsagePolicySchema.parse({
  version: "synthetic:1",
  costUnit: "unit",
  inputCostUnitsPerToken: 1,
  outputCostUnitsPerToken: 1,
  maxRequests: 2,
  maxTokens: 40,
  maxCostUnits: 100,
  maxConcurrentRequests: 1,
  maxRequestDurationMs: 1000,
  maxInputTokens: 10,
  maxOutputTokens: 10,
  maxToolCalls: 0,
});
const budget = { inputTokenCeiling: 10, tutoring: policy, evaluation: policy };
const legacy = { model: "synthetic-model", providerId: "synthetic-provider" };
const route = (value: object) => PrivateProviderRouteSchema.safeParse(value).success;

describe("captured private inference route", () => {
  it("reads legacy routes without inventing a budget and freezes explicit policies", () => {
    expect(PrivateProviderRouteSchema.parse(legacy)).toStrictEqual(legacy);
    const explicit = PrivateProviderRouteSchema.parse({ ...legacy, budget });
    expect(explicit.budget).toEqual(budget);
    expect(Object.isFrozen(explicit)).toBe(true);
    expect(Object.isFrozen(explicit.budget)).toBe(true);
    expect(route({ ...legacy, apiKey: "not-allowed" })).toBe(false);
    for (const field of ["model", "providerId"]) {
      expect(route({ ...legacy, [field]: "" })).toBe(false);
      expect(route({ ...legacy, [field]: "ab" })).toBe(true);
    }
  });

  it("freezes an optional separate evaluation provider and model", () => {
    const evaluation = { providerId: "judge-provider", model: "judge-model" };
    expect(PrivateProviderRouteSchema.parse({ ...legacy, evaluation }).evaluation).toEqual(
      evaluation,
    );
    for (const field of ["providerId", "model"]) {
      expect(route({ ...legacy, evaluation: { ...evaluation, [field]: "" } })).toBe(false);
      expect(route({ ...legacy, evaluation: { ...evaluation, [field]: "ab" } })).toBe(true);
    }
    expect(route({ ...legacy, evaluation: { ...evaluation, budget } })).toBe(false);
  });

  it("requires both purposes to reserve the full declared input ceiling", () => {
    for (const inputTokenCeiling of [1, 10])
      expect(RouteBudgetSchema.safeParse({ ...budget, inputTokenCeiling }).success).toBe(true);
    for (const inputTokenCeiling of [0, -1, 1.5, NaN, Infinity, 11, Number.MAX_SAFE_INTEGER + 1])
      expect(RouteBudgetSchema.safeParse({ ...budget, inputTokenCeiling }).success).toBe(false);
    for (const purpose of ["tutoring", "evaluation"])
      expect(
        RouteBudgetSchema.safeParse({ ...budget, [purpose]: { ...policy, maxInputTokens: 9 } })
          .error?.issues[0]?.message,
      ).toBe("Both budgets must reserve the complete captured route input ceiling.");
    expect(RouteBudgetSchema.safeParse({ inputTokenCeiling: 10, tutoring: policy }).success).toBe(
      false,
    );
    expect(RouteBudgetSchema.safeParse({ ...budget, defaultBudget: true }).success).toBe(false);
  });
});

it("allows an unlimited purpose to ignore its dormant input ceiling independently", () => {
  const unlimited = { ...policy, unlimited: true, maxInputTokens: 1 };
  expect(RouteBudgetSchema.safeParse({ ...budget, tutoring: unlimited }).success).toBe(true);
  expect(RouteBudgetSchema.safeParse({ ...budget, evaluation: unlimited }).success).toBe(true);
  expect(
    RouteBudgetSchema.safeParse({
      inputTokenCeiling: 100,
      tutoring: unlimited,
      evaluation: unlimited,
    }).success,
  ).toBe(true);
  expect(
    RouteBudgetSchema.safeParse({ ...budget, tutoring: { ...unlimited, unlimited: false } })
      .success,
  ).toBe(false);
  expect(
    RouteBudgetSchema.safeParse({ ...budget, evaluation: { ...unlimited, unlimited: false } })
      .success,
  ).toBe(false);
});
