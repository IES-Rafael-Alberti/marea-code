import {
  parseTelemetryExporterConfiguration,
  TelemetryExporterError,
  telemetryExporterFailure,
  type TelemetryEnvelope,
  type TelemetryExporterFactory,
} from "@marea/plugin-api";
import { snapshotConnection } from "./connection.boundary.js";
import { consumeResponse } from "./response.boundary.js";
import { encodeEnvelope } from "./wire.js";

export const createLangfuseExporter: TelemetryExporterFactory<"langfuse"> = (
  configuration,
  connection,
) => {
  const settings = parseTelemetryExporterConfiguration(configuration);
  if (settings.destination !== "langfuse")
    throw new TelemetryExporterError("invalid-configuration");
  const privateConnection = snapshotConnection(connection);
  const active = new Set<AbortController>();
  let closing: Promise<void> | undefined;

  const deliver = async (envelope: TelemetryEnvelope, signal: AbortSignal): Promise<void> => {
    if (closing) throw new TelemetryExporterError("closed");
    if (signal.aborted) throw new TelemetryExporterError("cancelled");
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    const deadline = performance.now() + settings.operationTimeoutMs;
    const timer = setTimeout(abort, settings.operationTimeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    active.add(controller);
    try {
      const body = encodeEnvelope(envelope);
      if (body.byteLength > settings.maxRequestBytes)
        throw new TelemetryExporterError("payload-too-large");
      if (performance.now() >= deadline) controller.abort();
      controller.signal.throwIfAborted();
      const response = await fetch(privateConnection.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: privateConnection.authorization,
          "content-type": "application/json",
          accept: "application/json",
          "x-langfuse-ingestion-version": "4",
        },
        body,
      });
      await consumeResponse(response, settings.maxResponseBytes);
      if (performance.now() >= deadline) controller.abort();
      controller.signal.throwIfAborted();
    } catch (error) {
      throw telemetryExporterFailure(error, controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      active.delete(controller);
      controller.abort();
    }
  };

  return Object.freeze({
    id: "langfuse",
    export: deliver,
    shutdown(signal: AbortSignal) {
      if (closing) return closing;
      closing = signal.aborted
        ? Promise.reject(new TelemetryExporterError("cancelled"))
        : Promise.resolve();
      for (const controller of active) controller.abort();
      return closing;
    },
  });
};
