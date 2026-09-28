import { describe, expect, it } from "vitest";

import { USAGE_POLICY } from "../../test-support/usage-fixture.js";
import { PrivateProviderRouteSchema, RouteBudgetSchema } from "./route-policy.js";

const budget = { inputTokenCeiling: 10, tutoring: USAGE_POLICY, evaluation: USAGE_POLICY };

describe("captured private inference route", () => {
  it("reads legacy routes without inventing a budget and preserves explicit separate policies", () => {
    const legacy = { model: "synthetic-model", providerId: "synthetic-provider" };
    expect(PrivateProviderRouteSchema.parse(legacy)).toStrictEqual(legacy);
    const explicit = PrivateProviderRouteSchema.parse({ ...legacy, budget });
    expect(explicit.budget).toEqual(budget);
    expect(Object.isFrozen(explicit)).toBe(true);
    expect(Object.isFrozen(explicit.budget)).toBe(true);
    expect(PrivateProviderRouteSchema.safeParse({ ...legacy, apiKey: "not-allowed" }).success).toBe(
      false,
    );
    for (const field of ["model", "providerId"])
      expect(PrivateProviderRouteSchema.safeParse({ ...legacy, [field]: "" }).success).toBe(false);
  });

  it("requires both purposes to reserve the full declared input ceiling", () => {
    for (const inputTokenCeiling of [1, 10])
      expect(RouteBudgetSchema.safeParse({ ...budget, inputTokenCeiling }).success).toBe(true);
    for (const inputTokenCeiling of [0, -1, 1.5, NaN, Infinity, 11, Number.MAX_SAFE_INTEGER + 1])
      expect(RouteBudgetSchema.safeParse({ ...budget, inputTokenCeiling }).success).toBe(false);
    for (const purpose of ["tutoring", "evaluation"])
      expect(
        RouteBudgetSchema.safeParse({
          ...budget,
          [purpose]: { ...USAGE_POLICY, maxInputTokens: 9 },
        }).success,
      ).toBe(false);
    expect(
      RouteBudgetSchema.safeParse({ inputTokenCeiling: 10, tutoring: USAGE_POLICY }).success,
    ).toBe(false);
    expect(RouteBudgetSchema.safeParse({ ...budget, defaultBudget: true }).success).toBe(false);
  });
});
