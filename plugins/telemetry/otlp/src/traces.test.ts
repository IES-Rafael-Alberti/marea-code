import { createOtlpExporter } from "./exporter.js";
import { settings, sample, connection } from "./otlp.fixture.js";
import { afterEach, expect, it, vi } from "vitest";
import { sessionTraceFixture as trace } from "@marea/plugin-api/testing";
import { traces } from "./traces.js";
afterEach(() => {
  vi.unstubAllGlobals();
});
it("uses OTLP trace endpoint and optional authorization without changing metric delivery", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  await traces
    .create({ endpoint: "http://127.0.0.1:4318/base", authorization: "Bearer synthetic" })
    .export(trace, new AbortController().signal);
  expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4318/base/v1/traces");
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    "Bearer synthetic",
  );
  fetcher.mockResolvedValue(
    new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  await traces
    .create({ endpoint: "http://127.0.0.1:4318" })
    .export(trace, new AbortController().signal);
  expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
  expect(() => traces.create({})).toThrow(
    expect.objectContaining({ code: "invalid-configuration" }),
  );
  fetcher.mockResolvedValue(
    new Response('{"partialSuccess":{"rejectedSpans":"1"}}', {
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(
    traces.create({ endpoint: "http://localhost" }).export(trace, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
});

it("appends the trace route without rewriting a matching segment inside the collector base path", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await traces
    .create({ endpoint: "http://localhost/v1/metrics/tenant" })
    .export(trace, new AbortController().signal);
  expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost/v1/metrics/tenant/v1/traces");
  expect(
    JSON.parse(new TextDecoder().decode(fetcher.mock.calls[0]?.[1]?.body as Uint8Array)),
  ).toMatchSnapshot("OTLP span wire contract");
});

it("still rejects partial metric delivery while trace delivery uses its own rejection count", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ partialSuccess: { rejectedDataPoints: 1 } })),
  );
  await expect(
    createOtlpExporter(settings, connection()).export(sample, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
});
