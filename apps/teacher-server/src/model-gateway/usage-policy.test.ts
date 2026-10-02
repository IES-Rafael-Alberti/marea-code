import { describe, expect, it } from "vitest";

import {
  admissionDenial,
  chargeForUsage,
  reservedCharge,
  UsagePolicySchema,
} from "./usage-policy.js";
import { USAGE_POLICY } from "../../test-support/usage-fixture.js";

const policy = UsagePolicySchema.parse({
  ...USAGE_POLICY,
  costUnit: "synthetic-test-unit",
  maxRequests: 2,
  maxTokens: 40,
  maxCostUnits: 100,
  maxToolCalls: 0,
});
const empty = { requests: 0, tokens: 0, costUnits: 0, inFlight: 0 };

describe("explicit inference usage policy", () => {
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

  it("charges exactly up to the safe integer limit and rejects larger usage", () => {
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
