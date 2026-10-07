import { afterEach, expect, it, vi } from "vitest";
import { listOpenRouterModels } from "./models.boundary.js";
const config = { apiKey: "synthetic-secret-key" };
const signal = () => new AbortController().signal;
const model = {
  id: "synthetic/model",
  name: "Synthetic Model",
  pricing: { prompt: "0.000001", completion: "0.000002" },
};
afterEach(() => {
  vi.unstubAllGlobals();
});
it("authenticates the key before querying account-filtered models and projects only model data", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ data: { label: "private-account" } }))
    .mockResolvedValueOnce(Response.json({ data: [model, { id: "manual", name: "Manual" }] }));
  vi.stubGlobal("fetch", fetch);
  const caller = signal();
  expect(await listOpenRouterModels(config, caller)).toEqual([
    {
      id: model.id,
      name: model.name,
      pricing: { costUnit: "nanoUSD", inputCostUnitsPerToken: 1000, outputCostUnitsPerToken: 2000 },
    },
    { id: "manual", name: "Manual", pricing: null },
  ]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://openrouter.ai/api/v1/key",
    "https://openrouter.ai/api/v1/models/user",
  ]);
  for (const [, init] of fetch.mock.calls)
    expect(init).toMatchObject({
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      redirect: "error",
      signal: expect.any(AbortSignal) as AbortSignal,
    });
});
it.each([401, 403, 429, 500])(
  "sanitizes HTTP %s without exposing response bodies",
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("private-provider-response", { status }));
    await expect(listOpenRouterModels(config, signal(), fetch)).rejects.toMatchObject({
      code: status === 401 || status === 403 ? "authentication-failed" : "unavailable",
      message: "The provider connection could not be verified.",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  new Response(null),
  new Response("invalid json"),
  new Response(new Uint8Array([255])),
  Response.json({ data: [] }),
  new Response(JSON.stringify({ data: {} }).padEnd(65537, " ")),
])("rejects invalid key responses", async (response) => {
  await expect(
    listOpenRouterModels(
      config,
      signal(),
      vi
        .fn()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(Response.json({ data: [model] })),
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
});
it("sanitizes transport errors and propagates caller cancellation to both requests", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | null | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
    observed = init?.signal;
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    return Promise.reject(new Error(config.apiKey));
  });
  await expect(
    listOpenRouterModels(
      { ...config, endpoint: "https://custom.test/v1/chat/completions" },
      controller.signal,
      fetch,
    ),
  ).rejects.toMatchObject({
    code: "unavailable",
    message: "The provider model catalog could not be loaded.",
    retryable: false,
  });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://custom.test/v1/key");
  expect(observed?.aborted).toBe(true);
});
it("rejects an invalid model catalog after authentication", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: {} }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: "", name: "Invalid" }] }));
  await expect(listOpenRouterModels(config, signal(), fetch)).rejects.toMatchObject({
    code: "unavailable",
  });
});

it("accepts the exact key response size and cancels both readers after consuming them", async () => {
  const key = new Response(JSON.stringify({ data: {} }).padEnd(65536, " "));
  const models = Response.json({ data: [model] });
  if (!key.body || !models.body) throw new Error("missing fixture body");
  const readers = [key.body, models.body].map((body) => {
    const reader = body.getReader();
    vi.spyOn(body, "getReader").mockReturnValue(reader);
    return vi.spyOn(reader, "cancel");
  });
  const fetch = vi.fn().mockResolvedValueOnce(key).mockResolvedValueOnce(models);
  await expect(listOpenRouterModels(config, signal(), fetch)).resolves.toHaveLength(1);
  for (const cancel of readers) expect(cancel).toHaveBeenCalledExactlyOnceWith();
});
it("classifies a rejected key with no response body", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
  await expect(listOpenRouterModels(config, signal(), fetch)).rejects.toMatchObject({
    code: "authentication-failed",
    message: "The provider connection could not be verified.",
    retryable: false,
  });
});
