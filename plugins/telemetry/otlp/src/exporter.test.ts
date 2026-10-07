import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryExporterError } from "@marea/plugin-api";
import plugin from "./index.js";
import { createOtlpExporter } from "./exporter.js";
import { settings, sample, connection, signal, success } from "./otlp.fixture.js";

function prepare() {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(success());
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OTLP construction and lifecycle", () => {
  it("exposes an executable metric and trace catalog entry and constructs without I/O or timers", async () => {
    const fetcher = prepare();
    vi.useFakeTimers();
    expect(plugin.manifest.capabilities).toEqual(["metric-export", "trace-export"]);
    expect(plugin.implementation?.destination).toBe("otlp");
    const port = createOtlpExporter(settings, connection());
    expect(Object.isFrozen(port)).toBe(true);
    expect(port.id).toBe("otlp");
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const closing = port.shutdown(signal());
    expect(port.shutdown(signal())).toBe(closing);
    await closing;
    await expect(port.export(sample, signal())).rejects.toMatchObject({ code: "closed" });
  });
  it("copies public settings, URL and private headers", async () => {
    const fetcher = prepare();
    const config = { ...settings };
    const privateConnection = connection();
    const port = createOtlpExporter(config, privateConnection);
    config.maxRequestBytes = 1;
    privateConnection.endpoint = "https://invalid.invalid";
    privateConnection.headers.authorization = "mutated";
    await port.export(sample, signal());
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4318/base/v1/metrics");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer synthetic",
    );
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("pre-aborts without transport and closes terminally even when shutdown is cancelled", async () => {
    const fetcher = prepare();
    const port = createOtlpExporter(settings, connection());
    const controller = new AbortController();
    controller.abort("private");
    await expect(port.export(sample, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    const closing = port.shutdown(controller.signal);
    expect(port.shutdown(signal())).toBe(closing);
    await expect(closing).rejects.toMatchObject({ code: "cancelled" });
    await expect(port.export(sample, controller.signal)).rejects.toMatchObject({ code: "closed" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["caller", "deadline", "shutdown"])(
    "cancels active transport on %s and cleans timers/listeners",
    async (mode) => {
      vi.useFakeTimers();
      const fetcher = prepare().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("private"));
              },
              {
                once: true,
              },
            );
          }),
      );
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const port = createOtlpExporter(settings, connection());
      const pending = expect(port.export(sample, controller.signal)).rejects.toMatchObject({
        code: "cancelled",
      });
      if (mode === "caller") controller.abort();
      else if (mode === "shutdown") await port.shutdown(signal());
      else await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("checks deadline after encoding and before I/O", async () => {
    const fetcher = prepare();
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(1000);
    await expect(
      createOtlpExporter(settings, connection()).export(sample, signal()),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sanitizes unexpected transport/encoding errors", async () => {
    prepare().mockRejectedValue(new Error("private URL secret"));
    const port = createOtlpExporter(settings, connection());
    await expect(port.export(sample, signal())).rejects.toEqual(
      new TelemetryExporterError("unavailable"),
    );
    await expect(port.export({ ...sample, occurredAt: "invalid" }, signal())).rejects.toEqual(
      new TelemetryExporterError("unavailable"),
    );
  });
});
it("rejects request oversize and translates invalid envelopes without leaking details", async () => {
  const fetcher = prepare();
  await expect(
    createOtlpExporter({ ...settings, maxRequestBytes: 1 }, connection()).export(sample, signal()),
  ).rejects.toEqual(new TelemetryExporterError("payload-too-large"));
  await expect(
    createOtlpExporter(settings, connection()).export({ ...sample, kind: "trace" }, signal()),
  ).rejects.toEqual(new TelemetryExporterError("unavailable"));
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses POST and fixed encoding headers, appends base paths and accepts exact request bytes", async () => {
  const fetcher = prepare();
  const privateConnection = { endpoint: "https://collector.invalid/prefix/nested/", headers: {} };
  const port = createOtlpExporter(settings, privateConnection);
  await port.export(sample, signal());
  const init = fetcher.mock.calls[0]?.[1];
  expect(init?.method).toBe("POST");
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://collector.invalid/prefix/nested/v1/metrics");
  const headers = new Headers(init?.headers);
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get("accept-encoding")).toBe("identity");
  const bytes = (init?.body as Uint8Array).byteLength;
  fetcher.mockResolvedValueOnce(success());
  await createOtlpExporter({ ...settings, maxRequestBytes: bytes }, privateConnection).export(
    sample,
    signal(),
  );
  await port.shutdown(signal());
  expect(init?.signal?.aborted).toBe(false);
});
it("checks elapsed time after response decoding", async () => {
  prepare();
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(1000);
  await expect(
    createOtlpExporter(settings, connection()).export(sample, signal()),
  ).rejects.toMatchObject({ code: "cancelled" });
});
it("observes cancellation at response completion even if transport has already resolved", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(control) {
      control.enqueue(new TextEncoder().encode("{}"));
    },
    pull(control) {
      controller.abort();
      control.close();
    },
  });
  prepare().mockResolvedValue(
    new Response(stream, { headers: { "content-type": "application/json" } }),
  );
  await expect(
    createOtlpExporter(settings, connection()).export(sample, controller.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
});
