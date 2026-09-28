import { expect, it } from "vitest";
import { telemetryRuntimeConfigurationSchema } from "./runtime-configuration.boundary.js";
import { runtimeFixture } from "./runtime.fixture.js";

it.each([
  { startupTimeoutMs: 0 },
  { startupTimeoutMs: 30_001 },
  { startupTimeoutMs: 1.5 },
  { maxInFlight: 0 },
  { maxInFlight: 33 },
  { maxInFlight: 1.5 },
  { enabled: "true" },
  { endpoint: "https://synthetic-secret.invalid" },
])("rejects invalid settings without relaxing limits: %j", (change) => {
  expect(
    telemetryRuntimeConfigurationSchema().safeParse({
      ...runtimeFixture().configuration,
      ...change,
    }).success,
  ).toBe(false);
});
it.each([
  { startupTimeoutMs: 1, maxInFlight: 1 },
  { startupTimeoutMs: 30_000, maxInFlight: 32 },
])("accepts exact bounds %j", (change) => {
  const parsed = telemetryRuntimeConfigurationSchema().parse({
    ...runtimeFixture().configuration,
    ...change,
  });
  expect(parsed).toMatchObject(change);
  expect(Object.isFrozen(parsed)).toBe(true);
});
it("limits selection to two known strict exporter configurations", () => {
  const f = runtimeFixture();
  const schema = telemetryRuntimeConfigurationSchema();
  expect(
    schema.safeParse({
      ...f.configuration,
      exporters: [...f.configuration.exporters, ...f.configuration.exporters],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ...f.configuration,
      exporters: f.configuration.exporters.map((settings) => ({
        ...settings,
        destination: "langsmith",
      })),
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ...f.configuration,
      exporters: f.configuration.exporters.map((settings) => ({
        ...settings,
        secretKey: "synthetic-secret",
      })),
    }).success,
  ).toBe(false);
});
