import { sessionTraceEnvelope, type SessionTraceImplementation } from "@marea/plugin-api";
import { createOtlpExporter } from "./exporter.js";

export const traces: SessionTraceImplementation = {
  settings: {
    version: 1,
    name: { es: "OTLP (HTTP/JSON)", en: "OTLP (HTTP/JSON)", eu: "OTLP (HTTP/JSON)" },
    fields: [
      {
        key: "endpoint",
        kind: "url",
        required: true,
        label: {
          es: "URL base del colector",
          en: "Collector base URL",
          eu: "Biltzailearen oinarrizko URLa",
        },
      },
      {
        key: "authorization",
        kind: "secret",
        required: false,
        label: {
          es: "Cabecera Authorization",
          en: "Authorization header",
          eu: "Authorization goiburua",
        },
      },
    ],
  },
  create(values) {
    const exporter = createOtlpExporter(
      {
        destination: "otlp",
        schemaVersion: "1.0",
        operationTimeoutMs: 10_000,
        maxRequestBytes: 262_144,
        maxResponseBytes: 16_384,
      },
      {
        endpoint: values.endpoint,
        headers: values.authorization ? { authorization: values.authorization } : {},
      },
    );
    return { export: (trace, signal) => exporter.export(sessionTraceEnvelope(trace), signal) };
  },
};
