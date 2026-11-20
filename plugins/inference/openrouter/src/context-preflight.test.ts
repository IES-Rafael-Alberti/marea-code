import { expect, it, vi } from "vitest";
import { createContextPreflight } from "./context-preflight.js";

const request = {
  messages: [{ role: "system" as const, content: "mandatory instructions" }],
  tools: [],
  requestId: "request:1",
  upstreamModel: "model",
};
const model = { id: "model", name: "Model", pricing: null, contextWindowTokens: 128_000 };
const signal = () => new AbortController().signal;

it("admits full material and reserves output even without a configured output cap", async () => {
  const preflight = createContextPreflight(() => Promise.resolve([model]));
  expect(await preflight(request, signal())).toEqual({ ...request, maxOutputTokens: 8192 });
  expect(await preflight({ ...request, maxOutputTokens: 12 }, signal())).toEqual({
    ...request,
    maxOutputTokens: 12,
  });
});
it("blocks unknown capacity and oversized prompts without changing their contents", async () => {
  const missing = createContextPreflight(() => Promise.resolve([]));
  await expect(missing(request, signal())).rejects.toMatchObject({
    code: "context-unavailable",
    retryable: true,
  });
  const small = createContextPreflight(() =>
    Promise.resolve([{ ...model, contextWindowTokens: 10 }]),
  );
  await expect(small(request, signal())).rejects.toMatchObject({
    code: "context-exceeded",
    retryable: false,
  });
  expect(request.messages[0]?.content).toBe("mandatory instructions");
});
it("refreshes cached capacity and retries failed catalog reads", async () => {
  let now = 1;
  const models = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([model]);
  const preflight = createContextPreflight(models, () => now);
  await expect(preflight(request, signal())).rejects.toMatchObject({ code: "context-unavailable" });
  await preflight(request, signal());
  await preflight(request, signal());
  expect(models).toHaveBeenCalledTimes(2);
  now += 300_000;
  await preflight(request, signal());
  expect(models).toHaveBeenCalledTimes(3);
});
it("does not fetch after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const models = vi.fn();
  await expect(createContextPreflight(models)(request, controller.signal)).rejects.toThrow();
  expect(models).not.toHaveBeenCalled();
});

it("reserves no more than the provider output ceiling", async () => {
  const preflight = createContextPreflight(() =>
    Promise.resolve([{ ...model, maxOutputTokens: 1024 }]),
  );
  expect((await preflight(request, signal())).maxOutputTokens).toBe(1024);
});
