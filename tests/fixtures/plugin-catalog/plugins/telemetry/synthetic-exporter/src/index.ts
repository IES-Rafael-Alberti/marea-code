import { defineTelemetryExporterCatalogEntry } from "../../../../../../../packages/plugin-api/src/index.js";

export default defineTelemetryExporterCatalogEntry({
  manifest: {
    id: "org.marea.fixture-telemetry",
    displayNameKey: "plugins.fixture-telemetry.name",
    descriptionKey: "plugins.fixture-telemetry.description",
    kind: "telemetry-exporter",
    apiVersion: "1.0",
    implementationVersion: "2.0.0-beta.1",
    entrypoint: "./src/index.ts",
    configurationVersion: 2,
    requiredDependencies: [],
    optionalDependencies: [],
    conflicts: [],
    capabilities: ["batch-export", "trace-export"],
    runtimeTargets: ["teacher-server"],
    acceptedDataClassifications: ["operational", "pseudonymous"],
    destination: "external",
  },
});
