import { afterEach, vi } from "vitest";
import {
  createFakeExporter,
  defineTelemetryExporterConformance,
} from "../../packages/telemetry-pipeline/src/exporter-conformance.fixture.js";
import { createLangfuseExporter } from "../../plugins/telemetry/langfuse/src/exporter.js";

// Host scheduling evidence with deterministic transport. Actual sockets and wire
// mapping are exercised separately in the plugin's local HTTP collector tests.
afterEach(() => vi.unstubAllGlobals());
defineTelemetryExporterConformance("langfuse", (scenario) => {
  vi.stubGlobal("fetch", (_url: string, options: RequestInit) => {
    if (scenario === "export-timeout") {
      return new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("synthetic transport abort"));
          },
          { once: true },
        );
      });
    }
    return Promise.resolve(
      new Response("{}", {
        status: scenario === "failure" ? 503 : 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  const candidate = createLangfuseExporter(
    {
      destination: "langfuse",
      schemaVersion: "1.0",
      operationTimeoutMs: 1000,
      maxRequestBytes: 262144,
      maxResponseBytes: 65536,
    },
    {
      endpoint: "http://127.0.0.1:1",
      publicKey: "synthetic-public",
      secretKey: "synthetic-secret",
    },
  );
  return createFakeExporter("langfuse", {
    export: candidate.export,
    async shutdown(signal) {
      await candidate.shutdown(signal);
      // This no-flush adapter closes synchronously. These two required shared
      // scenarios inject host-boundary faults *after* actual terminal cleanup;
      // they do not claim native adapter shutdown can time out/fail this way.
      if (scenario === "shutdown-failure") throw new Error("synthetic shutdown failure");
      if (scenario === "shutdown-timeout") {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });
});
