import { describe, expect, it } from "vitest";

import {
  admissionDenial,
  chargeForUsage,
  reservedCharge,
  UsagePolicySchema,
} from "./usage-policy.js";

const policy = UsagePolicySchema.parse({
  version: "synthetic:1",
  costUnit: "synthetic-test-unit",
  inputCostUnitsPerToken: 2,
  outputCostUnitsPerToken: 3,
  maxRequests: 2,
  maxTokens: 40,
  maxCostUnits: 100,
  maxConcurrentRequests: 1,
  maxRequestDurationMs: 1000,
  maxInputTokens: 10,
  maxOutputTokens: 10,
  maxToolCalls: 0,
});
const empty = { requests: 0, tokens: 0, costUnits: 0, inFlight: 0 };

describe("explicit inference usage policy", () => {
  it("requires complete operator values and exact nonnegative integer counters", () => {
    expect(Object.isFrozen(policy)).toBe(true);
    for (const field of Object.keys(policy)) {
      const missing = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== field));
      expect(UsagePolicySchema.safeParse(missing).success).toBe(false);
    }
    expect(UsagePolicySchema.safeParse({ ...policy, extra: true }).success).toBe(false);
    for (const field of ["version", "costUnit"] as const) {
      for (const value of ["", "a".repeat(field === "version" ? 129 : 65)])
        expect(UsagePolicySchema.safeParse({ ...policy, [field]: value }).success).toBe(false);
    }
    for (const [field] of Object.entries(policy).filter(([, value]) => typeof value === "number")) {
      for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
        expect(UsagePolicySchema.safeParse({ ...policy, [field]: value }).success).toBe(false);
    }
    for (const field of [
      "maxConcurrentRequests",
      "maxRequestDurationMs",
      "maxInputTokens",
      "maxOutputTokens",
    ])
      expect(UsagePolicySchema.safeParse({ ...policy, [field]: 0 }).success).toBe(false);
    expect(
      UsagePolicySchema.safeParse({ ...policy, maxRequestDurationMs: 2_147_483_648 }).success,
    ).toBe(false);
    expect(
      UsagePolicySchema.safeParse({ ...policy, maxRequestDurationMs: 2_147_483_647 }).success,
    ).toBe(true);
  });

  it("reserves worst-case usage and applies inclusive budget and concurrency boundaries", () => {
    expect(reservedCharge(policy)).toEqual({ inputTokens: 10, outputTokens: 10, costUnits: 50 });
    expect(chargeForUsage(policy, { inputTokens: 3, outputTokens: 2 })).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      costUnits: 12,
    });
    expect(admissionDenial(policy, empty)).toBeNull();
    expect(
      admissionDenial(policy, { requests: 1, tokens: 20, costUnits: 50, inFlight: 0 }),
    ).toBeNull();
    expect(admissionDenial(policy, { ...empty, requests: 2 })).toBe("requests");
    expect(admissionDenial(policy, { ...empty, inFlight: 1 })).toBe("concurrency");
    expect(admissionDenial(policy, { ...empty, tokens: 21 })).toBe("tokens");
    expect(admissionDenial(policy, { ...empty, costUnits: 51 })).toBe("cost");
    expect(admissionDenial({ ...policy, maxRequests: 0 }, empty)).toBe("requests");
    expect(
      reservedCharge({ ...policy, inputCostUnitsPerToken: 0, outputCostUnitsPerToken: 0 })
        .costUnits,
    ).toBe(0);
  });

  it("rejects overflow instead of rounding monetary or token values", () => {
    expect(
      UsagePolicySchema.safeParse({
        ...policy,
        maxInputTokens: Number.MAX_SAFE_INTEGER,
        inputCostUnitsPerToken: 0,
        outputCostUnitsPerToken: 0,
      }).success,
    ).toBe(false);
    expect(
      UsagePolicySchema.safeParse({
        ...policy,
        inputCostUnitsPerToken: Number.MAX_SAFE_INTEGER,
        outputCostUnitsPerToken: 0,
      }).success,
    ).toBe(false);
    expect(
      UsagePolicySchema.safeParse({ ...policy, maxInputTokens: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(false);
    expect(
      UsagePolicySchema.safeParse({ ...policy, outputCostUnitsPerToken: Number.MAX_SAFE_INTEGER })
        .success,
    ).toBe(false);
    expect(() =>
      chargeForUsage(policy, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }),
    ).toThrow("Usage cost exceeds exact storage.");
    const exact = UsagePolicySchema.parse({
      ...policy,
      maxInputTokens: Number.MAX_SAFE_INTEGER - 1,
      maxOutputTokens: 1,
      inputCostUnitsPerToken: 1,
      outputCostUnitsPerToken: 1,
      maxTokens: Number.MAX_SAFE_INTEGER,
      maxCostUnits: Number.MAX_SAFE_INTEGER,
    });
    expect(reservedCharge(exact).costUnits).toBe(Number.MAX_SAFE_INTEGER);
    expect(admissionDenial(exact, empty)).toBeNull();
    expect(admissionDenial(exact, { ...empty, tokens: 1 })).toBe("tokens");
    expect(admissionDenial(exact, { ...empty, costUnits: 1 })).toBe("cost");
  });
});
