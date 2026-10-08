import { expect, it } from "vitest";
import { ServerSetupRequestSchema } from "./server-setup.js";
const usage = {
  version: "policy:setup",
  costUnit: "unit",
  inputCostUnitsPerToken: 0,
  outputCostUnitsPerToken: 0,
  maxRequests: 1,
  maxTokens: 20,
  maxCostUnits: 1,
  maxConcurrentRequests: 1,
  maxRequestDurationMs: 1000,
  maxInputTokens: 10,
  maxOutputTokens: 10,
  maxToolCalls: 0,
  unlimited: true,
};
const input = {
  center: "School",
  classroom: "Class",
  teacher: "Teacher",
  login: "teacher",
  password: "synthetic-password",
  port: 18787,
  access: "lan",
  publicOrigin: "",
  connections: { provider: { apiKey: "secret" } },
  route: {
    providerId: "provider",
    model: "model",
    budget: { inputTokenCeiling: 10, tutoring: usage, evaluation: usage },
  },
  testingSkill: false,
};
it("requires the complete setup document and an explicit usage policy", () => {
  expect(ServerSetupRequestSchema.parse(input)).toEqual(input);
  for (const key of Object.keys(input)) {
    const partial = { ...input };
    Reflect.deleteProperty(partial, key);
    expect(ServerSetupRequestSchema.safeParse(partial).success).toBe(false);
  }
  expect(
    ServerSetupRequestSchema.safeParse({
      ...input,
      route: { providerId: "provider", model: "model" },
    }).success,
  ).toBe(false);
  expect(ServerSetupRequestSchema.safeParse({ ...input, extra: true }).success).toBe(false);
  for (const access of ["local", "lan", "https"])
    expect(ServerSetupRequestSchema.safeParse({ ...input, access }).success).toBe(true);
  for (const access of ["http", "remote", ""])
    expect(ServerSetupRequestSchema.safeParse({ ...input, access }).success).toBe(false);
});
it("bounds local port, origins and provider connection fields", () => {
  for (const port of [1024, 65535])
    expect(ServerSetupRequestSchema.safeParse({ ...input, port }).success).toBe(true);
  for (const port of [1023, 65536, 1024.5])
    expect(ServerSetupRequestSchema.safeParse({ ...input, port }).success).toBe(false);
  for (const size of [2048, 2049])
    expect(
      ServerSetupRequestSchema.safeParse({ ...input, publicOrigin: "x".repeat(size) }).success,
    ).toBe(size === 2048);
  for (const [providerSize, keySize, valueSize, valid] of [
    [128, 64, 2048, true],
    [129, 64, 2048, false],
    [128, 65, 2048, false],
    [128, 64, 2049, false],
  ] as const)
    expect(
      ServerSetupRequestSchema.safeParse({
        ...input,
        connections: {
          ["p".repeat(providerSize)]: { ["k".repeat(keySize)]: "v".repeat(valueSize) },
        },
      }).success,
    ).toBe(valid);
});
it("keeps identity providers optional with bounded IDs, settings and count", () => {
  const parse = (identityProviders: object) =>
    ServerSetupRequestSchema.safeParse({ ...input, identityProviders }).success;
  expect(parse({})).toBe(true);
  expect(parse({ "org.example.login": { customField: "value" } })).toBe(true);
  expect(parse({ "../path": {} })).toBe(false);
  for (const [keySize, valueSize, valid] of [
    [64, 16384, true],
    [65, 16384, false],
    [64, 16385, false],
  ] as const)
    expect(parse({ "org.example.login": { ["k".repeat(keySize)]: "v".repeat(valueSize) } })).toBe(
      valid,
    );
  for (const count of [8, 9])
    expect(
      parse(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`org.example.p${String(index)}`, {}]),
        ),
      ),
    ).toBe(count === 8);
});

it("validates every optional feature without silently dropping it", () => {
  const features = { map: true, reports: false, automaticEvaluation: true };
  expect(ServerSetupRequestSchema.parse({ ...input, features }).features).toEqual(features);
  expect(
    ServerSetupRequestSchema.safeParse({ ...input, features: { ...features, extra: true } })
      .success,
  ).toBe(false);
  for (const key of Object.keys(features)) {
    const partial = { ...features };
    Reflect.deleteProperty(partial, key);
    expect(ServerSetupRequestSchema.safeParse({ ...input, features: partial }).success).toBe(false);
  }
});
