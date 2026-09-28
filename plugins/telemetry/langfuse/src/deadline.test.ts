import { afterEach, expect, it, vi } from "vitest";
import { TelemetryExporterError } from "@marea/plugin-api";
import { createLangfuseExporter } from "./exporter.js";
import { envelope, settings, signal } from "./exporter.fixture.js";

afterEach(() => vi.restoreAllMocks());
it.each(["encoding", "decoding"])(
  "enforces the total deadline after synchronous %s work",
  async (phase) => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0);
    if (phase === "decoding") now.mockReturnValueOnce(0);
    now.mockReturnValue(500);
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
    const port = createLangfuseExporter(settings, {
      endpoint: "http://127.0.0.1:1",
      publicKey: "synthetic-public",
      secretKey: "synthetic-secret",
    });
    await expect(port.export(envelope, signal())).rejects.toEqual(
      new TelemetryExporterError("cancelled"),
    );
    expect(transport).toHaveBeenCalledTimes(phase === "encoding" ? 0 : 1);
  },
);

it.each(["caller", "shutdown"])(
  "aborts transport immediately on %s, independently of the deadline",
  async (mode) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const listen = vi.spyOn(caller.signal, "addEventListener");
    let transportSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      transportSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        transportSignal?.addEventListener(
          "abort",
          () => {
            reject(new Error("synthetic abort"));
          },
          { once: true },
        );
      });
    });
    const port = createLangfuseExporter(settings, {
      endpoint: "http://127.0.0.1:1",
      publicKey: "p",
      secretKey: "s",
    });
    const pending = expect(port.export(envelope, caller.signal)).rejects.toEqual(
      new TelemetryExporterError("cancelled"),
    );
    expect(listen).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(transportSignal?.aborted).toBe(false);
    if (mode === "caller") caller.abort();
    else await port.shutdown(signal());
    expect(transportSignal?.aborted).toBe(true);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  },
);
it("does not retain completed controllers until shutdown", async () => {
  const abort = vi.spyOn(AbortController.prototype, "abort");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  const port = createLangfuseExporter(settings, {
    endpoint: "http://127.0.0.1:1",
    publicKey: "p",
    secretKey: "s",
  });
  await port.export(envelope, signal());
  const count = abort.mock.calls.length;
  expect(count).toBe(1);
  await port.shutdown(signal());
  expect(abort).toHaveBeenCalledTimes(count);
});
