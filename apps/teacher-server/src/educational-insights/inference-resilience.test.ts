import { expect, it, vi } from "vitest";
import * as z from "zod";
import {
  InferenceProviderError,
  type InferenceCancellation,
  type InferenceProvider,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "@marea/plugin-api";
import { fixture } from "./insights.fixture.js";
import { EducationalInference } from "./inference.js";
import { InsightsFailure } from "./model-output.boundary.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { NOW } from "../../test-support/evaluation-fixture.js";

const schema = z.object({ ok: z.boolean() });
const SCHEMA_LINE = `\nReturn JSON matching: ${JSON.stringify(z.toJSONSchema(schema))}`;
const route = {
  providerId: "synthetic",
  model: "synthetic",
  budget: SYNTHETIC_ROUTE_BUDGET.evaluation,
  inputTokenCeiling: 65536,
};
const unlimited = {
  ...route,
  budget: {
    ...SYNTHETIC_ROUTE_BUDGET.evaluation,
    unlimited: true,
    maxRequests: 0,
    maxTokens: 0,
    maxCostUnits: 0,
  },
};

const HANG = { hang: true } as const;
type Attempt = string | Error | typeof HANG;
function answer(text: string): InferenceProviderEvent[] {
  return [
    { type: "text-delta", text },
    { type: "usage", inputTokens: 10, outputTokens: 5 },
    { type: "completed", finishReason: "stop" },
  ];
}
/** Each call consumes the next scripted attempt: an answer, a failure or a stall. */
function scripted(...attempts: Attempt[]) {
  const requests: InferenceProviderRequest[] = [];
  const cancellations: InferenceCancellation[] = [];
  const provider: InferenceProvider = {
    async *stream(request, cancellation) {
      await Promise.resolve();
      requests.push(request);
      cancellations.push(cancellation);
      const next = attempts[requests.length - 1];
      if (next === undefined) throw new Error("unscripted");
      if (next instanceof Error) throw next;
      if (typeof next === "string") yield* answer(next);
      else await new Promise<never>(() => undefined);
    },
  };
  return { provider, requests, cancellations };
}
function setup(provider: InferenceProvider) {
  const f = fixture();
  const inference = new EducationalInference(
    f.database,
    { resolve: () => provider },
    { now: () => NOW },
  );
  inference.retryDelayMs = 0;
  return inference;
}
const run = (inference: EducationalInference, signal = new AbortController().signal, r = route) =>
  inference.generate(r, "account", "Analyze", { evidence: "x" }, schema, signal);
const unavailable = () =>
  new InferenceProviderError({ code: "unavailable", message: "down", retryable: true });

it("accepts answers wrapped in a code fence", async () => {
  const { provider, requests } = scripted('Here you go:\n```json\n{"ok":true}\n```');
  await expect(run(setup(provider))).resolves.toEqual({ ok: true });
  expect(requests).toHaveLength(1);
});

it("repairs an invalid answer once, telling the model what was wrong", async () => {
  const { provider, requests } = scripted('{"ok":"yes"}', '{"ok":true}');
  const inference = setup(provider);
  await expect(run(inference)).resolves.toEqual({ ok: true });
  expect(requests).toHaveLength(2);
  expect(requests[0]?.messages).toEqual([
    { role: "system", content: `Analyze${SCHEMA_LINE}` },
    { role: "user", content: '{"evidence":"x"}' },
  ]);
  expect(requests[1]?.messages).toEqual([
    {
      role: "system",
      content: `Analyze${SCHEMA_LINE}\nYour previous answer was rejected: ok: Invalid input: expected boolean, received string. Return only one corrected JSON object.`,
    },
    { role: "user", content: '{"evidence":"x"}' },
  ]);
  expect(inference.usage("account", route)).toMatchObject({ requests: 2 });
});

it("asks for a JSON object when the first answer has none", async () => {
  const { provider, requests } = scripted("I cannot comply", '{"ok":false}');
  await expect(run(setup(provider))).resolves.toEqual({ ok: false });
  expect(requests[1]?.messages[0]?.content).toContain(
    "rejected: the answer was not a JSON object. Return",
  );
});

it("fails with output-invalid after one repair attempt", async () => {
  const { provider, requests } = scripted("nope", '{"ok":1}', '{"ok":true}');
  const result = run(setup(provider));
  await expect(result).rejects.toBeInstanceOf(InsightsFailure);
  await expect(result).rejects.toMatchObject({ code: "output-invalid" });
  expect(requests).toHaveLength(2);
});

it("retries one transient provider failure and then succeeds", async () => {
  const { provider, requests } = scripted(unavailable(), '{"ok":true}');
  await expect(run(setup(provider))).resolves.toEqual({ ok: true });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.messages).toEqual(requests[0]?.messages);
});

it("waits the configured delay before retrying a transient failure", async () => {
  const { provider } = scripted(unavailable(), '{"ok":true}');
  const inference = setup(provider);
  inference.retryDelayMs = 60;
  const started = performance.now();
  await run(inference);
  expect(performance.now() - started).toBeGreaterThanOrEqual(55);
});

it("gives up after a second transient failure with a provider code", async () => {
  const { provider, requests } = scripted(unavailable(), unavailable(), '{"ok":true}');
  await expect(run(setup(provider))).rejects.toMatchObject({ code: "provider" });
  expect(requests).toHaveLength(2);
});

it.each([
  [new InferenceProviderError({ code: "authentication-failed", message: "x", retryable: false })],
  [new Error("boom")],
])("does not retry a permanent failure %#", async (error) => {
  const { provider, requests } = scripted(error, '{"ok":true}');
  await expect(run(setup(provider))).rejects.toMatchObject({ code: "provider" });
  expect(requests).toHaveLength(1);
});

it("reports an oversized provider context as input-too-large", async () => {
  const { provider } = scripted(
    new InferenceProviderError({ code: "context-exceeded", message: "x", retryable: false }),
  );
  await expect(run(setup(provider))).rejects.toMatchObject({ code: "input-too-large" });
});

it("reports an exhausted budget with the budget code", async () => {
  const { provider } = scripted('{"ok":true}', '{"ok":true}');
  const limited = { ...route, budget: { ...route.budget, maxRequests: 1 } };
  const inference = setup(provider);
  await run(inference, undefined, limited);
  await expect(run(inference, undefined, limited)).rejects.toMatchObject({ code: "budget" });
});

it("applies a deadline even when the budget is unlimited", async () => {
  const { provider, cancellations } = scripted(HANG);
  const inference = setup(provider);
  inference.deadlineMs = 30;
  const started = performance.now();
  await expect(run(inference, undefined, unlimited)).rejects.toMatchObject({ code: "deadline" });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(cancellations[0]?.aborted).toBe(true);
});

it("does not retry once the deadline passed", async () => {
  const { provider, requests } = scripted(HANG, '{"ok":true}');
  const inference = setup(provider);
  inference.deadlineMs = 30;
  await expect(run(inference, undefined, unlimited)).rejects.toMatchObject({ code: "deadline" });
  expect(requests).toHaveLength(1);
});

it("keeps the default model deadline at five minutes", () => {
  const f = fixture();
  expect(
    new EducationalInference(f.database, { resolve: () => undefined }, f.service.clock),
  ).toMatchObject({
    deadlineMs: 300_000,
    retryDelayMs: 1000,
  });
});

it("clears the deadline timer after a call", async () => {
  const { provider } = scripted('{"ok":true}');
  const inference = setup(provider);
  inference.deadlineMs = 4321;
  const set = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  await run(inference, undefined, unlimited);
  const call = set.mock.calls.findIndex(([, delay]) => delay === 4321);
  expect(call).toBeGreaterThanOrEqual(0);
  expect(clear.mock.calls.some(([handle]) => handle === set.mock.results[call]?.value)).toBe(true);
  set.mockRestore();
  clear.mockRestore();
});

it("surfaces a teacher cancellation as the original abort, not a deadline", async () => {
  const { provider } = scripted(HANG);
  const controller = new AbortController();
  const result = run(setup(provider), controller.signal, unlimited);
  await vi.waitFor(() => undefined);
  controller.abort();
  await expect(result).rejects.toBeInstanceOf(InferenceProviderError);
  await expect(result).rejects.toMatchObject({ code: "aborted" });
});

it("rejects a repair prompt that no longer fits the input ceiling", async () => {
  const { provider, requests } = scripted('{"ok":"x"}', '{"ok":true}');
  const system = `Analyze${SCHEMA_LINE}`;
  const exact = Buffer.byteLength(system) + Buffer.byteLength('{"evidence":"x"}');
  const inference = setup(provider);
  await expect(
    run(inference, undefined, { ...route, inputTokenCeiling: exact }),
  ).rejects.toMatchObject({ code: "input-too-large" });
  expect(requests).toHaveLength(1);
  const accepted = scripted('{"ok":true}');
  await expect(
    run(setup(accepted.provider), undefined, { ...route, inputTokenCeiling: exact }),
  ).resolves.toEqual({ ok: true });
});

it("reports a missing provider as unconfigured", async () => {
  const f = fixture();
  const inference = new EducationalInference(
    f.database,
    { resolve: () => undefined },
    f.service.clock,
  );
  await expect(run(inference)).rejects.toMatchObject({ code: "unconfigured" });
});
