import { defineTelemetryExporterCatalogEntry } from "@marea/plugin-api";
import { createLangfuseExporter } from "./exporter.js";

export default defineTelemetryExporterCatalogEntry({
  manifest: {
    id: "org.marea.langfuse",
    displayNameKey: "plugins.langfuse.name",
    descriptionKey: "plugins.langfuse.description",
    kind: "telemetry-exporter",
    apiVersion: "1.0",
    implementationVersion: "0.1.0",
    entrypoint: "./src/index.ts",
    configurationVersion: 1,
    capabilities: ["metric-export"],
    runtimeTargets: ["teacher-server"],
    acceptedDataClassifications: ["operational"],
    destination: "external",
    requiredDependencies: [],
    optionalDependencies: [],
    conflicts: [],
  },
  implementation: { destination: "langfuse", create: createLangfuseExporter },
});
