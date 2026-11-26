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
  expect(await preflight(request, signal())).toEqual({
    ...request,
    maxOutputTokens: 8192,
    contextWindowTokens: 128_000,
  });
  expect(await preflight({ ...request, maxOutputTokens: 12 }, signal())).toEqual({
    ...request,
    maxOutputTokens: 12,
    contextWindowTokens: 128_000,
  });
});
it("blocks unknown capacity and oversized prompts without changing their contents", async () => {
  const missing = createContextPreflight(() => Promise.resolve([]));
  await expect(missing(request, signal())).rejects.toMatchObject({
    code: "context-unavailable",
    retryable: true,
    message:
      "The model context capacity could not be verified. Retry or ask your teacher to select a model with a known context capacity.",
  });
  const small = createContextPreflight(() =>
    Promise.resolve([{ ...model, contextWindowTokens: 10 }]),
  );
  await expect(small(request, signal())).rejects.toMatchObject({
    code: "context-exceeded",
    retryable: false,
    message:
      "The complete session exceeds the conservative context budget. Ask your teacher to reduce the materials or select a model with a larger context, then start a new session. Nothing was truncated or summarized.",
  });
  expect(request.messages[0]?.content).toBe("mandatory instructions");
});
it("refreshes cached capacity and retries failed catalog reads", async () => {
  let now = 1;
  const models = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([model]);
  const preflight = createContextPreflight(models, () => now);
  await expect(preflight(request, signal())).rejects.toMatchObject({
    code: "context-unavailable",
    retryable: true,
    message: "The model context capacity could not be verified. Retry before continuing.",
  });
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

it("selects the requested model and rejects catalogs without its capacity", async () => {
  const other = { ...model, id: "different", contextWindowTokens: 1 };
  const models = [other, model];
  await expect(
    createContextPreflight(() => Promise.resolve(models))(request, signal()),
  ).resolves.toMatchObject({ maxOutputTokens: 8192 });
  for (const catalog of [[other], [{ id: "model", name: "Unknown", pricing: null }]]) {
    await expect(
      createContextPreflight(() => Promise.resolve(catalog))(request, signal()),
    ).rejects.toMatchObject({ code: "context-unavailable" });
  }
});

it("includes UTF-8 messages, tools, framing and output at the exact admission boundary", async () => {
  const turn = {
    ...request,
    messages: [{ role: "system" as const, content: "Explica 🧪 y á" }],
    tools: [
      {
        name: "read",
        description: "Read a resource",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
    maxOutputTokens: 100,
  };
  const payloadBytes = Buffer.byteLength(
    JSON.stringify({ messages: turn.messages, tools: turn.tools }),
    "utf8",
  );
  const capacity = payloadBytes + 4096 + 100;
  const preflight = (limit: number) =>
    createContextPreflight(() => Promise.resolve([{ ...model, contextWindowTokens: limit }]));
  await expect(preflight(capacity)(turn, signal())).resolves.toEqual({
    ...turn,
    contextWindowTokens: capacity,
  });
  await expect(preflight(capacity - 1)(turn, signal())).rejects.toMatchObject({
    code: "context-exceeded",
  });
});

it("shrinks output asked beyond the default to the room left, never below the default", async () => {
  const input = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: [] })) + 4096;
  const preflight = (capacity: number) =>
    createContextPreflight(() =>
      Promise.resolve([{ ...model, contextWindowTokens: capacity, maxOutputTokens: 943_718 }]),
    );
  const wide = { ...request, maxOutputTokens: 32_768 };
  await expect(preflight(input + 32_768)(wide, signal())).resolves.toMatchObject({
    maxOutputTokens: 32_768,
  });
  await expect(preflight(input + 20_000)(wide, signal())).resolves.toMatchObject({
    maxOutputTokens: 20_000,
  });
  await expect(preflight(input + 8192)(wide, signal())).resolves.toMatchObject({
    maxOutputTokens: 8192,
  });
  await expect(preflight(input + 8191)(wide, signal())).rejects.toMatchObject({
    code: "context-exceeded",
  });
});

it("honors cancellation while the model catalog is loading", async () => {
  const controller = new AbortController();
  const preflight = createContextPreflight(() => {
    controller.abort(new Error("catalog cancelled"));
    return Promise.resolve([model]);
  });
  await expect(preflight(request, controller.signal)).rejects.toThrow("catalog cancelled");
});

it("loads the first catalog regardless of the injected clock origin", async () => {
  const models = vi.fn().mockResolvedValue([model]);
  const preflight = createContextPreflight(models, () => -1);
  await expect(preflight(request, signal())).resolves.toMatchObject({ maxOutputTokens: 8192 });
  expect(models).toHaveBeenCalledTimes(1);
});
