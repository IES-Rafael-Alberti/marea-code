import { describe, expect, it } from "vitest";

import { UsagePolicySchema } from "./inference-budget.js";

const policy = {
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
};
const accepts = (value: object) => UsagePolicySchema.safeParse(value).success;
const issue = (value: object) => UsagePolicySchema.safeParse(value).error?.issues[0]?.message;
const MAX = Number.MAX_SAFE_INTEGER;

describe("explicit inference usage policy", () => {
  it("requires complete, strict and frozen operator values", () => {
    expect(Object.isFrozen(UsagePolicySchema.parse(policy))).toBe(true);
    for (const field of Object.keys(policy))
      expect(
        accepts(Object.fromEntries(Object.entries(policy).filter(([key]) => key !== field))),
      ).toBe(false);
    expect(accepts({ ...policy, extra: true })).toBe(false);
  });

  it("bounds labels and counters inclusively", () => {
    for (const [field, max] of [
      ["version", 128],
      ["costUnit", 64],
    ] as const) {
      for (const value of ["a", "a".repeat(max)])
        expect(accepts({ ...policy, [field]: value })).toBe(true);
      for (const value of ["", "a".repeat(max + 1)])
        expect(accepts({ ...policy, [field]: value })).toBe(false);
    }
    for (const [field] of Object.entries(policy).filter(([, value]) => typeof value === "number"))
      for (const value of [-1, 0.5, Infinity, NaN, MAX + 1])
        expect(accepts({ ...policy, [field]: value })).toBe(false);
    for (const field of [
      "maxConcurrentRequests",
      "maxRequestDurationMs",
      "maxInputTokens",
      "maxOutputTokens",
    ])
      expect(accepts({ ...policy, [field]: 0 })).toBe(false);
    expect(accepts({ ...policy, maxRequestDurationMs: 2_147_483_647 })).toBe(true);
    expect(accepts({ ...policy, maxRequestDurationMs: 2_147_483_648 })).toBe(false);
  });

  it("rejects reservations beyond exact counters instead of rounding them", () => {
    const zeroCost = { ...policy, inputCostUnitsPerToken: 0, outputCostUnitsPerToken: 0 };
    expect(accepts({ ...zeroCost, maxInputTokens: MAX - 1, maxOutputTokens: 1 })).toBe(true);
    expect(issue({ ...zeroCost, maxInputTokens: MAX, maxOutputTokens: 1 })).toBe(
      "A reservation must fit the exact token counter.",
    );
    const half = Math.floor(MAX / 2);
    expect(
      accepts({
        ...policy,
        maxInputTokens: half,
        inputCostUnitsPerToken: 2,
        maxOutputTokens: 1,
        outputCostUnitsPerToken: 1,
      }),
    ).toBe(true);
    for (const costly of [
      {
        maxInputTokens: half + 1,
        inputCostUnitsPerToken: 2,
        maxOutputTokens: 1,
        outputCostUnitsPerToken: 0,
      },
      {
        maxInputTokens: 1,
        inputCostUnitsPerToken: 0,
        maxOutputTokens: half + 1,
        outputCostUnitsPerToken: 2,
      },
    ])
      expect(issue({ ...policy, ...costly })).toBe(
        "A reservation must fit the exact cost counter.",
      );
  });
});

it("keeps unlimited usage explicit and bypasses only dormant reservation ceilings", () => {
  const large = { ...policy, maxInputTokens: MAX, maxOutputTokens: MAX, unlimited: true };
  expect(accepts(large)).toBe(true);
  expect(accepts({ ...large, unlimited: false })).toBe(false);
  expect(accepts({ ...policy, unlimited: "yes" })).toBe(false);
  expect(UsagePolicySchema.parse({ ...policy, unlimited: false }).unlimited).toBe(false);
  expect(UsagePolicySchema.parse({ ...policy, unlimited: true }).unlimited).toBe(true);
});
