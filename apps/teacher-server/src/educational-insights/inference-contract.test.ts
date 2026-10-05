import { expect, it, vi } from "vitest";
import * as z from "zod";
import type { InferenceProviderRequest, InferenceProviderEvent } from "@marea/plugin-api";
import { fixture } from "./insights.fixture.js";
import { EducationalInference } from "./inference.js";
import { EducationalRouteSchema } from "./configuration.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { NOW } from "../../test-support/evaluation-fixture.js";

it("sends the model its schema, exact material and no tools, and reports durable usage", async () => {
  const f = fixture();
  const schema = z.object({ ok: z.boolean() });
  const system = `Analyze\nReturn JSON matching: ${JSON.stringify(z.toJSONSchema(schema))}`;
  const material = { evidence: "á🙂" };
  const text = JSON.stringify(material);
  const stream = vi.fn(async function* (
    _request: InferenceProviderRequest,
  ): AsyncIterable<InferenceProviderEvent> {
    await Promise.resolve();
    expect(_request.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    yield { type: "text-delta", text: '{"ok":' };
    yield { type: "text-delta", text: "true}" };
    yield { type: "usage", inputTokens: 100, outputTokens: 10 };
    yield { type: "completed", finishReason: "stop" };
  });
  const resolve = vi.fn(() => ({ stream }));
  const inference = new EducationalInference(f.database, { resolve }, { now: () => NOW });
  const route = {
    providerId: "synthetic-provider",
    model: "analysis-model",
    budget: SYNTHETIC_ROUTE_BUDGET.evaluation,
    inputTokenCeiling: Buffer.byteLength(system) + Buffer.byteLength(text),
  };
  const signal = new AbortController().signal;
  await expect(
    inference.generate(route, "map:class:day", "Analyze", material, schema, signal),
  ).resolves.toEqual({ ok: true });
  expect(resolve).toHaveBeenCalledWith(route.providerId);
  expect(stream.mock.calls[0]?.[0]).toMatchObject({
    upstreamModel: "analysis-model",
    tools: [],
    messages: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
  });
  expect(inference.usage("map:class:day", route)).toMatchObject({
    requests: 1,
    tokens: 110,
    maxRequests: route.budget.maxRequests,
    maxTokens: route.budget.maxTokens,
    maxCostUnits: route.budget.maxCostUnits,
    costUnit: route.budget.costUnit,
  });
  await expect(
    inference.generate(
      { ...route, inputTokenCeiling: route.inputTokenCeiling - 1 },
      "too-large",
      "Analyze",
      material,
      schema,
      signal,
    ),
  ).rejects.toThrow("input-too-large");
  expect(stream).toHaveBeenCalledOnce();
  expect(inference.usage("too-large", route)?.requests).toBe(0);
  expect(
    EducationalRouteSchema.safeParse({
      ...route,
      inputTokenCeiling: route.budget.maxInputTokens + 1,
    }).success,
  ).toBe(false);
  expect(
    EducationalRouteSchema.parse({ ...route, inputTokenCeiling: route.budget.maxInputTokens })
      .inputTokenCeiling,
  ).toBe(route.budget.maxInputTokens);
});

it("accepts a valid JSON response at the output byte limit", async () => {
  const f = fixture();
  const value = "x".repeat(1048574);
  const inference = new EducationalInference(
    f.database,
    {
      resolve: () => ({
        async *stream(): AsyncIterable<InferenceProviderEvent> {
          await Promise.resolve();
          yield { type: "text-delta", text: JSON.stringify(value) };
          yield { type: "usage", inputTokens: 1, outputTokens: 1 };
          yield { type: "completed", finishReason: "stop" };
        },
      }),
    },
    { now: () => NOW },
  );
  const route = f.service.configuration.map;
  if (route === undefined) throw new Error("route");
  await expect(
    inference.generate(route, "limit", "Analyze", {}, z.string(), new AbortController().signal),
  ).resolves.toBe(value);
});
