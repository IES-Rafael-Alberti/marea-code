import type { TelemetryExporterDestination, TelemetryExporterPort } from "@marea/plugin-api";

/** Snapshot public methods, never inspect an adapter's potentially private ID. */
export function snapshotTelemetryPort(
  destination: TelemetryExporterDestination,
  port: TelemetryExporterPort,
): TelemetryExporterPort {
  return Object.freeze({
    id: destination,
    export: port.export.bind(port),
    shutdown: port.shutdown.bind(port),
  });
}

/** A malformed factory result can still own resources: give shutdown a bounded cleanup attempt. */
export async function discardTelemetryPort(
  port: TelemetryExporterPort,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const expired = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    controller.abort();
    expired.resolve(undefined);
  }, timeoutMs);
  try {
    await Promise.race([
      Promise.resolve().then(() => port.shutdown(controller.signal)),
      expired.promise,
    ]);
  } catch {
    /* Never expose malformed ports or private cleanup errors. */
  } finally {
    clearTimeout(timer);
  }
}
