import {
  TelemetryExporterError,
  type SessionTrace,
  type SessionTraceExporter,
} from "@marea/plugin-api";

/** Host deadline also covers an exporter that fails to settle after cancellation. */
export async function deliverTrace(
  exporter: SessionTraceExporter,
  trace: SessionTrace,
  signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10_000);
  const combined = AbortSignal.any([signal, controller.signal]);
  const cancelled = Promise.withResolvers<never>();
  const cancel = () => {
    cancelled.reject(new TelemetryExporterError("cancelled"));
  };
  combined.addEventListener("abort", cancel);
  if (combined.aborted) cancel();
  try {
    await Promise.race([
      cancelled.promise,
      Promise.resolve().then(() => exporter.export(trace, combined)),
    ]);
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener("abort", cancel);
    controller.abort();
  }
}
