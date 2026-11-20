import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { boundedDownload, downloadPreview } from "./preview-download.boundary.ts";

// Real HTTP and native timers: fake timers do not reliably control AbortSignal.timeout.
export async function verifySlowTransfer(settings, destination, ports, slowAsset) {
  const runtime = await import("bun");
  let slowRequests = 0;
  const server = runtime.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const path = new globalThis.URL(request.url).pathname;
      if (path === "/stall") {
        return new globalThis.Response(
          new globalThis.ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        );
      }
      const response = await ports.fetch(request.url);
      if (!path.endsWith(`/${slowAsset}`)) return response;
      slowRequests += 1;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const chunkSize = Math.ceil(bytes.length / 4);
      let offset = 0;
      return new globalThis.Response(
        new globalThis.ReadableStream({
          async pull(controller) {
            if (offset > 0) await delay(12_000);
            const end = Math.min(offset + chunkSize, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
            if (offset === bytes.length) controller.close();
          },
        }),
      );
    },
  });
  const fetcher = (url, init) =>
    globalThis.fetch(new globalThis.URL(new globalThis.URL(url).pathname, server.url), init);
  const started = performance.now();
  try {
    await Promise.all([
      downloadPreview(settings, settings.version, settings.target, destination, {
        ...ports,
        fetch: fetcher,
      }),
      (async () => {
        const stalledAt = performance.now();
        await assert.rejects(boundedDownload(fetcher, `${server.url}stall`, 1024), {
          name: "AbortError",
        });
        const elapsed = performance.now() - stalledAt;
        assert.ok(elapsed >= 29_000 && elapsed < 45_000, `Stalled download: ${elapsed} ms`);
      })(),
    ]);
    assert.equal(slowRequests, 1, "Steady transfer must finish without retries");
    assert.ok(performance.now() - started >= 35_000, "Transfer must exceed the old deadline");
  } finally {
    server.stop(true);
  }
}
