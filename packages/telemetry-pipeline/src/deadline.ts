import type { TelemetryExporterOutcomeStatus } from "./contracts.js";

type BoundedOperation = (signal: AbortSignal) => Promise<void>;

async function runOperation(
  operation: BoundedOperation,
  operationSignal: AbortSignal,
): Promise<TelemetryExporterOutcomeStatus> {
  try {
    await operation(operationSignal);
    return "succeeded";
  } catch {
    return "failed";
  }
}

export async function runBoundedOperation(
  operation: BoundedOperation,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<TelemetryExporterOutcomeStatus> {
  if (parentSignal.aborted) {
    return "cancelled";
  }
  const operationController = new AbortController();
  const interruption = Promise.withResolvers<TelemetryExporterOutcomeStatus>();
  const cancel = (): void => {
    operationController.abort();
    interruption.resolve("cancelled");
  };
  const timeout = setTimeout(() => {
    operationController.abort();
    interruption.resolve("timed-out");
  }, timeoutMs);
  parentSignal.addEventListener("abort", cancel);
  try {
    return await Promise.race([
      runOperation(operation, operationController.signal),
      interruption.promise,
    ]);
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", cancel);
  }
}
