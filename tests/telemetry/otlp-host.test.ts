import { afterEach, vi } from "vitest";
import {
  createFakeExporter,
  defineTelemetryExporterConformance,
} from "../../packages/telemetry-pipeline/src/exporter-conformance.fixture.js";
import { createOtlpExporter } from "../../plugins/telemetry/otlp/src/exporter.js";
import { connection, settings, success } from "../../plugins/telemetry/otlp/src/otlp.fixture.js";

// Host/port tests: deterministic transport; all exports and shutdowns delegate to
// the production adapter. Shutdown faults are injected AFTER its terminal cleanup.
afterEach(() => vi.unstubAllGlobals());
defineTelemetryExporterConformance("otlp", (scenario) => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      if (scenario === "export-timeout")
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("synthetic abort"));
            },
            {
              once: true,
            },
          );
        });
      return Promise.resolve(
        scenario === "failure" ? new Response("synthetic", { status: 503 }) : success(),
      );
    }),
  );
  const actual = createOtlpExporter(settings, connection());
  return createFakeExporter(actual.id, {
    export: actual.export,
    shutdown: async (signal) => {
      await actual.shutdown(signal);
      if (scenario === "shutdown-failure") throw new Error("private synthetic shutdown fault");
      if (scenario === "shutdown-timeout")
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
    },
  });
});
