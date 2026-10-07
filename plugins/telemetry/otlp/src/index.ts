import {
  createTelemetryExporterManifestSchema,
  defineTelemetryExporterCatalogEntry,
} from "@marea/plugin-api";
import manifest from "../plugin.json";
import { createOtlpExporter } from "./exporter.js";
import { traces } from "./traces.js";

export default defineTelemetryExporterCatalogEntry({
  traces,
  manifest: createTelemetryExporterManifestSchema().parse(manifest),
  implementation: { destination: "otlp", create: createOtlpExporter },
});
