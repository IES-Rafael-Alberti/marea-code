import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  requestModels,
  useProviderModels,
  type ModelCatalogs,
} from "./provider-models.boundary.js";
import type { EditableSettings } from "./client.boundary.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
type HookValue = object | string | number | boolean | null;
const hooks = vi.hoisted(() => ({
  values: [] as HookValue[],
  index: 0,
  effects: [] as (() => () => void)[],
  deps: [] as HookValue[],
}));
vi.mock("react", () => ({
  useState: (initial: HookValue) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (next: HookValue | ((previous: HookValue) => HookValue)) => {
        hooks.values[index] =
          typeof next === "function"
            ? (next as (previous: HookValue) => HookValue)(hooks.values[index] ?? null)
            : next;
      },
    ];
  },
  useEffect: (effect: () => () => void, deps: HookValue[]) => {
    hooks.effects.push(effect);
    hooks.deps = deps;
  },
}));
const model = { id: "example/model", name: "Example", pricing: null };
const state: EditableSettings = {
  administrator: true,
  initialized: true,
  revision: 0,
  useCommonRoute: false,
  legacyRoutes: [],
  route: null,
  education: {},
  providers: [
    {
      id: "p",
      supportsModels: true,
      descriptor: {
        version: 1,
        name: { es: "P", en: "P", eu: "P" },
        fields: [
          { key: "key", kind: "secret", required: true, label: { es: "K", en: "K", eu: "K" } },
        ],
      },
      configured: true,
      values: {},
      secrets: [],
    },
  ],
};
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
  hooks.effects = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
it("projects model responses and passes the draft and cancellation signal", async () => {
  const fetch = vi
    .fn<DashboardFetch>()
    .mockResolvedValue(Response.json({ providerId: "p", models: [model] }));
  const signal = new AbortController().signal;
  await expect(requestModels(fetch, "p", { key: "draft" }, signal)).resolves.toEqual({
    status: "ready",
    models: [model],
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v1/dashboard/server-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "models", providerId: "p", values: { key: "draft" } }),
    signal,
  });
});
it.each([400, 503])("returns actionable status for HTTP %s", async (status) => {
  const response = new Response(null, { status });
  await expect(
    requestModels(vi.fn().mockResolvedValue(response), "p", {}, new AbortController().signal),
  ).resolves.toEqual({ status: status === 400 ? "invalid" : "unavailable", models: [] });
});
it.each([
  JSON.stringify({ providerId: "p", models: [] }).padEnd(2097153, " "),
  JSON.stringify({ providerId: "other", models: [] }),
  JSON.stringify({ providerId: "p", models: [{}] }),
  "invalid",
])("rejects malformed catalog responses", async (body) => {
  await expect(
    requestModels(
      vi.fn().mockResolvedValue(new Response(body)),
      "p",
      {},
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it("debounces complete credentials, supports refresh, and rejects stale results", async () => {
  const deferred = Promise.withResolvers<Response>();
  const fetch = vi.fn<DashboardFetch>().mockReturnValue(deferred.promise);
  const result = useProviderModels(fetch, state, { p: { key: "draft" } });
  const cleanup = hooks.effects[0]?.();
  expect(hooks.values[0]).toEqual({ p: { status: "loading", models: [] } });
  await vi.advanceTimersByTimeAsync(799);
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup?.();
  expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  deferred.resolve(Response.json({ providerId: "p", models: [model] }));
  await vi.runAllTimersAsync();
  expect((hooks.values[0] as ModelCatalogs).p?.status).toBe("loading");
  result.refresh();
  expect(hooks.values[1]).toBe(1);
  expect(hooks.deps).toEqual([
    fetch,
    JSON.stringify([{ providerId: "p", values: { key: "draft" } }]),
    0,
  ]);
});
it.each([true, false])(
  "stores completed requests or sanitized failures: success=%s",
  async (success) => {
    const fetch = vi.fn<DashboardFetch>();
    if (success) fetch.mockResolvedValue(Response.json({ providerId: "p", models: [model] }));
    else fetch.mockRejectedValue(new Error("secret transport detail"));
    useProviderModels(fetch, state, { p: { key: "draft" } });
    const cleanup = hooks.effects[0]?.();
    await vi.runAllTimersAsync();
    expect(hooks.values[0]).toEqual({
      p: { status: success ? "ready" : "unavailable", models: success ? [model] : [] },
    });
    cleanup?.();
  },
);
it("waits for required fields but accepts stored secrets and descriptor defaults", async () => {
  const fetch = vi
    .fn<DashboardFetch>()
    .mockResolvedValue(Response.json({ providerId: "p", models: [] }));
  for (const selected of [
    null,
    { administrator: false as const, initialized: true },
    state,
    { ...state, providers: state.providers.map((p) => ({ ...p, supportsModels: false })) },
    { ...state, providers: state.providers.map((p) => ({ ...p, descriptor: null })) },
  ]) {
    useProviderModels(fetch, selected, {});
    const cleanup = hooks.effects.at(-1)?.();
    await vi.runAllTimersAsync();
    cleanup?.();
  }
  useProviderModels(fetch, state, { p: {} });
  hooks.effects.at(-1)?.()();
  expect(fetch).not.toHaveBeenCalled();
  const saved = { ...state, providers: state.providers.map((p) => ({ ...p, secrets: ["key"] })) };
  useProviderModels(fetch, saved, { p: {} });
  const cleanup = hooks.effects.at(-1)?.();
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup?.();
});

it("accepts the exact response ceiling and identifies malformed responses", async () => {
  const signal = new AbortController().signal;
  const body = JSON.stringify({ providerId: "p", models: [] });
  await expect(
    requestModels(
      vi.fn<DashboardFetch>().mockResolvedValue(new Response(body.padEnd(2097152, " "))),
      "p",
      {},
      signal,
    ),
  ).resolves.toEqual({ status: "ready", models: [] });
  await expect(
    requestModels(
      vi.fn<DashboardFetch>().mockResolvedValue(new Response(body.padEnd(2097153, " "))),
      "p",
      {},
      signal,
    ),
  ).rejects.toThrow("oversized-model-catalog");
  await expect(
    requestModels(
      vi.fn<DashboardFetch>().mockResolvedValue(Response.json({ providerId: "other", models: [] })),
      "p",
      {},
      signal,
    ),
  ).rejects.toThrow("unexpected-provider");
});
it("cancels a pending debounce before it contacts the provider", async () => {
  const fetch = vi.fn<DashboardFetch>();
  useProviderModels(fetch, state, { p: { key: "draft" } });
  const cleanup = hooks.effects[0]?.();
  cleanup?.();
  await vi.runAllTimersAsync();
  expect(fetch).not.toHaveBeenCalled();
});
it("requires every mandatory field, includes optional fields and accepts descriptor defaults", async () => {
  const fetch = vi
    .fn<DashboardFetch>()
    .mockImplementation(() => Promise.resolve(Response.json({ providerId: "p", models: [] })));
  const provider = state.providers[0];
  if (!provider?.descriptor) throw new Error("missing descriptor");
  const field = provider.descriptor.fields[0];
  if (!field) throw new Error("missing key field");
  const selected = {
    ...state,
    providers: [
      {
        ...provider,
        descriptor: {
          ...provider.descriptor,
          fields: [
            field,
            { ...field, key: "optional", required: false },
            { ...field, key: "defaulted", defaultValue: "default" },
          ],
        },
      },
    ],
  };
  useProviderModels(fetch, selected, { p: {} });
  let cleanup = hooks.effects.at(-1)?.();
  await vi.runAllTimersAsync();
  expect(fetch).not.toHaveBeenCalled();
  expect(hooks.values[0]).toEqual({});
  cleanup?.();
  useProviderModels(fetch, selected, { p: { key: "complete" } });
  cleanup = hooks.effects.at(-1)?.();
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup?.();
});
