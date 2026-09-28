import {
  createTelemetryExporterManifestSchema,
  defineTelemetryExporterCatalogEntry,
} from "@marea/plugin-api";
import manifest from "../plugin.json";
import { createOtlpExporter } from "./exporter.js";

export default defineTelemetryExporterCatalogEntry({
  manifest: createTelemetryExporterManifestSchema().parse(manifest),
  implementation: { destination: "otlp", create: createOtlpExporter },
});
