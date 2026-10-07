import { sessionTraceEnvelope, type SessionTraceImplementation } from "@marea/plugin-api";
import { createLangfuseExporter } from "./exporter.js";

export const traces: SessionTraceImplementation = {
  settings: {
    version: 1,
    name: { es: "Langfuse", en: "Langfuse", eu: "Langfuse" },
    fields: [
      {
        key: "endpoint",
        kind: "url",
        required: true,
        defaultValue: "https://cloud.langfuse.com",
        label: { es: "URL de Langfuse", en: "Langfuse URL", eu: "Langfuse URLa" },
      },
      {
        key: "publicKey",
        kind: "secret",
        required: true,
        label: { es: "Clave pública", en: "Public key", eu: "Gako publikoa" },
      },
      {
        key: "secretKey",
        kind: "secret",
        required: true,
        label: { es: "Clave secreta", en: "Secret key", eu: "Gako sekretua" },
      },
    ],
  },
  create(values) {
    const exporter = createLangfuseExporter(
      {
        destination: "langfuse",
        schemaVersion: "1.0",
        operationTimeoutMs: 10_000,
        maxRequestBytes: 262_144,
        maxResponseBytes: 16_384,
      },
      {
        endpoint: values.endpoint,
        publicKey: values.publicKey,
        secretKey: values.secretKey,
      },
    );
    return { export: (trace, signal) => exporter.export(sessionTraceEnvelope(trace), signal) };
  },
};
