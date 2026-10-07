import { it, expect } from "vitest";
import * as z from "zod";
import type { InferenceProviderEvent } from "@marea/plugin-api";
import { fixture } from "./insights.fixture.js";
import { EducationalRouteSchema } from "./configuration.js";
import { EducationalInference } from "./inference.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { NOW } from "../../test-support/evaluation-fixture.js";
it("enforces independent durable budgets and reserves no student usage", async () => {
  const f = fixture();
  let calls = 0;
  const provider = analysisProvider(() => {
    calls++;
  });
  const inference = new EducationalInference(
    f.database,
    { resolve: () => provider },
    { now: () => NOW },
  );
  const route = {
    providerId: "synthetic",
    model: "synthetic",
    budget: { ...SYNTHETIC_ROUTE_BUDGET.evaluation, maxRequests: 1 },
    inputTokenCeiling: 65536,
  };
  const schema = z.object({ ok: z.boolean() });
  const signal = new AbortController().signal;
  expect(await inference.generate(route, "map:class:day", "Analyze", {}, schema, signal)).toEqual({
    ok: true,
  });
  await expect(
    inference.generate(route, "map:class:day", "Analyze", {}, schema, signal),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(f.database.readAll("SELECT * FROM marea_usage_accounts")).toHaveLength(0);
  expect(inference.ledger.totals({ runId: "map:class:day", purpose: "evaluation" }).requests).toBe(
    1,
  );
  await inference.generate(route, "report:separate", "Analyze", {}, schema, signal);
  expect(calls).toBe(2);
  await expect(
    inference.generate(
      { ...route, inputTokenCeiling: 1 },
      "report:oversized",
      "Analyze",
      {},
      schema,
      signal,
    ),
  ).rejects.toThrow("input-too-large");
  expect(calls).toBe(2);
});
it.each([
  [{ type: "completed", finishReason: "length" }],
  [{ type: "tool-call", callId: "call", name: "unexpected", arguments: {} }],
  [{ type: "text-delta", text: "x".repeat(1048577) }],
] as InferenceProviderEvent[][])("rejects unsafe analysis output %#", async (...events) => {
  const f = fixture();
  const inference = new EducationalInference(
    f.database,
    {
      resolve: () => ({
        async *stream() {
          await Promise.resolve();
          yield { type: "usage", inputTokens: 1, outputTokens: 1 };
          for (const event of events.flat()) yield event;
        },
      }),
    },
    { now: () => NOW },
  );
  await expect(
    inference.generate(
      routeOf(f),
      "invalid-output",
      "Analyze",
      {},
      z.object({ ok: z.boolean() }),
      new AbortController().signal,
    ),
  ).rejects.toThrow("invalid-output");
});
it("rejects missing providers and exposes absent and configured budgets", async () => {
  const f = fixture();
  expect(f.service.inference.usage("missing", undefined)).toBeNull();
  expect(f.service.inference.usage("missing", f.service.configuration.map)).toMatchObject({
    requests: 0,
  });
  await expect(
    f.service.inference.generate(
      routeOf(f),
      "missing",
      "Analyze",
      {},
      z.object({}),
      new AbortController().signal,
    ),
  ).rejects.toThrow("unconfigured");
});

function routeOf(f: ReturnType<typeof fixture>) {
  const route = f.service.configuration.map;
  if (!route) throw new Error("missing route");
  return route;
}

it("allows unlimited educational analysis and projects absent ceilings explicitly", async () => {
  const f = fixture();
  const provider = analysisProvider(() => undefined);
  const inference = new EducationalInference(
    f.database,
    { resolve: () => provider },
    { now: () => NOW },
  );
  const route = {
    ...routeOf(f),
    inputTokenCeiling: 1,
    budget: {
      ...SYNTHETIC_ROUTE_BUDGET.evaluation,
      unlimited: true,
      maxRequests: 0,
      maxTokens: 0,
      maxCostUnits: 0,
    },
  };
  await expect(
    inference.generate(
      route,
      "unlimited",
      "Analyze material beyond the dormant input ceiling",
      {},
      z.object({ ok: z.boolean() }),
      new AbortController().signal,
    ),
  ).resolves.toEqual({ ok: true });
  expect(
    EducationalRouteSchema.safeParse({
      ...route,
      inputTokenCeiling: route.budget.maxInputTokens + 1,
    }).success,
  ).toBe(true);
  expect(
    EducationalRouteSchema.safeParse({
      ...route,
      inputTokenCeiling: route.budget.maxInputTokens + 1,
      budget: { ...route.budget, unlimited: false },
    }).success,
  ).toBe(false);
  expect(inference.usage("unlimited", route)).toEqual({
    requests: 1,
    tokens: 110,
    costUnits: 230,
    inFlight: 0,
    maxRequests: null,
    maxTokens: null,
    maxCostUnits: null,
    costUnit: route.budget.costUnit,
  });
});

function analysisProvider(onRequest: () => void) {
  return {
    async *stream(): AsyncIterable<InferenceProviderEvent> {
      await Promise.resolve();
      onRequest();
      yield { type: "text-delta", text: '{"ok":true}' };
      yield { type: "usage", inputTokens: 100, outputTokens: 10 };
      yield { type: "completed", finishReason: "stop" };
    },
  };
}
