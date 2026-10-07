import {
  TelemetryExporterError,
  telemetryExporterFailure,
  type TelemetryExporterFactory,
  type TelemetryEnvelope,
  encodeSessionTrace,
} from "@marea/plugin-api";
import { snapshot } from "./configuration.boundary.js";
import { encodeMetrics } from "./encoding.js";
import { consumeResponse } from "./response.boundary.js";

export const createOtlpExporter: TelemetryExporterFactory<"otlp"> = (configuration, connection) => {
  const { settings, endpoint, headers } = snapshot(configuration, connection);
  const active = new Set<AbortController>();
  let closing: Promise<void> | undefined;
  const send = async (
    envelope: TelemetryEnvelope,
    controller: AbortController,
    started: number,
  ) => {
    const body =
      envelope.trace === undefined ? encodeMetrics(envelope) : encodeSessionTrace(envelope.trace);
    if (body.byteLength > settings.maxRequestBytes)
      throw new TelemetryExporterError("payload-too-large");
    if (performance.now() - started >= settings.operationTimeoutMs) controller.abort();
    controller.signal.throwIfAborted();
    const response = await fetch(
      envelope.trace === undefined ? endpoint : endpoint.replace(/\/v1\/metrics$/u, "/v1/traces"),
      {
        method: "POST",
        body,
        headers,
        signal: controller.signal,
        redirect: "error",
      },
    );
    await consumeResponse(
      response,
      settings.maxResponseBytes,
      envelope.trace === undefined ? "rejectedDataPoints" : "rejectedSpans",
    );
    if (performance.now() - started >= settings.operationTimeoutMs) controller.abort();
    controller.signal.throwIfAborted();
  };
  const deliver = async (envelope: TelemetryEnvelope, signal: AbortSignal): Promise<void> => {
    if (closing) throw new TelemetryExporterError("closed");
    if (signal.aborted) throw new TelemetryExporterError("cancelled");
    const started = performance.now();
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal.addEventListener("abort", abort);
    const timer = setTimeout(abort, settings.operationTimeoutMs);
    active.add(controller);
    try {
      await send(envelope, controller, started);
    } catch (error) {
      throw telemetryExporterFailure(error, controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      active.delete(controller);
    }
  };
  return Object.freeze({
    id: "otlp",
    export: deliver,
    shutdown: (signal: AbortSignal) => {
      if (!closing) {
        closing = signal.aborted
          ? Promise.reject(new TelemetryExporterError("cancelled"))
          : Promise.resolve();
        for (const controller of active) controller.abort();
      }
      return closing;
    },
  });
};
