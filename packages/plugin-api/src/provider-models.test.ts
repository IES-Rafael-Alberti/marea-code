import { expect, it } from "vitest";
import { ProviderModelSchema, ProviderModelListSchema } from "./provider-models.js";
const pricing = {
  costUnit: "nanoUSD",
  inputCostUnitsPerToken: 1000,
  outputCostUnitsPerToken: 2000,
};
const model = { id: "provider/model", name: "Model", pricing };
it("accepts free and unknown tariffs while rejecting private extra fields", () => {
  expect(ProviderModelSchema.parse(model)).toEqual(model);
  expect(ProviderModelSchema.parse({ ...model, pricing: null }).pricing).toBeNull();
  for (const value of [
    { ...model, secret: "private" },
    { ...model, pricing: { ...pricing, key: "secret" } },
    { id: model.id, name: model.name },
  ])
    expect(ProviderModelSchema.safeParse(value).success).toBe(false);
  expect(
    ProviderModelSchema.parse({
      ...model,
      pricing: { ...pricing, inputCostUnitsPerToken: 0, outputCostUnitsPerToken: 0 },
    }).pricing,
  ).toMatchObject({ inputCostUnitsPerToken: 0, outputCostUnitsPerToken: 0 });
});
it("bounds names, identifiers, currency and exact nonnegative prices", () => {
  for (const key of ["id", "name"] as const) {
    for (const length of [1, 512])
      expect(ProviderModelSchema.safeParse({ ...model, [key]: "x".repeat(length) }).success).toBe(
        true,
      );
    for (const value of ["", "x".repeat(513), 1])
      expect(ProviderModelSchema.safeParse({ ...model, [key]: value }).success).toBe(false);
  }
  for (const length of [1, 64])
    expect(
      ProviderModelSchema.safeParse({
        ...model,
        pricing: { ...pricing, costUnit: "x".repeat(length) },
      }).success,
    ).toBe(true);
  for (const value of ["", "x".repeat(65), 1])
    expect(
      ProviderModelSchema.safeParse({ ...model, pricing: { ...pricing, costUnit: value } }).success,
    ).toBe(false);
  for (const key of ["inputCostUnitsPerToken", "outputCostUnitsPerToken"] as const)
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"])
      expect(
        ProviderModelSchema.safeParse({ ...model, pricing: { ...pricing, [key]: value } }).success,
      ).toBe(false);
});
it("bounds the catalog and validates every model", () => {
  expect(ProviderModelListSchema.parse([])).toEqual([]);
  expect(ProviderModelListSchema.parse(Array.from({ length: 5000 }, () => model))).toHaveLength(
    5000,
  );
  expect(ProviderModelListSchema.safeParse(Array.from({ length: 5001 }, () => model)).success).toBe(
    false,
  );
  expect(ProviderModelListSchema.safeParse([model, {}]).success).toBe(false);
});
