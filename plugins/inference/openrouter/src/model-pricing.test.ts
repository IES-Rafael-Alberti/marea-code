import { expect, it } from "vitest";
import { modelPricing } from "./model-pricing.boundary.js";
it.each([
  ["0", 0],
  ["12", 12000000000],
  ["0".repeat(64), 0],
  ["0.0000000010", 1],
  ["0.000003", 3000],
  ["2.5e-7", 250],
  ["1E+1", 10000000000],
  ["0.0000000001", 1],
  ["1e-100", 1],
  ["9.007199254740991e6", Number.MAX_SAFE_INTEGER],
])("converts %s USD/token to exact nanodollars", (value, units) => {
  expect(modelPricing({ prompt: value, completion: value })).toEqual({
    costUnit: "nanoUSD",
    inputCostUnitsPerToken: units,
    outputCostUnitsPerToken: units,
  });
});
it.each([
  "-1",
  "garbage",
  "1USD",
  "0".repeat(65),
  "",
  "1e101",
  "1e-101",
  "1e999999999999999999",
  "1".repeat(65),
  "9007199.254740992",
])("leaves unavailable or unsafe prices unquoted: %s", (value) => {
  expect(modelPricing({ prompt: value, completion: "0" })).toBeNull();
  expect(modelPricing({ prompt: "0", completion: value })).toBeNull();
});
it.each([null, {}, { prompt: 1, completion: 2 }])("rejects malformed pricing", (value) => {
  expect(modelPricing(value)).toBeNull();
});
