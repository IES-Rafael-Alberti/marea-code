import type { OperationalTelemetryRuntime } from "@marea/telemetry-pipeline";

/** Records only duration and outcome, never request, response or exception context. */
export async function observeServerOperation<T>(
  telemetry: OperationalTelemetryRuntime,
  operation: () => Promise<T>,
  succeeded: (result: T) => boolean,
): Promise<T> {
  const started = performance.now();
  let success = false;
  try {
    const result = await operation();
    success = succeeded(result);
    return result;
  } finally {
    try {
      await telemetry.emit(
        {
          id: "server-operation",
          name: "server-operation",
          kind: "metric",
          occurredAt: new Date().toISOString(),
          attributes: [
            {
              key: "operation.duration-ms",
              classification: "operational",
              value: performance.now() - started,
            },
            { key: "operation.succeeded", classification: "operational", value: success },
          ],
        },
        new AbortController().signal,
      );
    } catch {
      /* Optional telemetry never replaces the operation result. */
    }
  }
}
