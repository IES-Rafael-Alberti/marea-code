import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { collect, REQUEST, TestCancellation } from "./openrouter.fixture.js";

afterEach(() => vi.unstubAllGlobals());
it("wires catalog admission into the production plugin and never sends an oversized completion", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ data: {} }))
    .mockResolvedValueOnce(
      Response.json({ data: [{ id: REQUEST.upstreamModel, name: "Model", context_length: 100 }] }),
    );
  vi.stubGlobal("fetch", fetch);
  const provider = plugin.create({ apiKey: "synthetic-secret-key" });
  await expect(collect(provider.stream(REQUEST, new TestCancellation()))).rejects.toMatchObject({
    code: "context-exceeded",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
});
