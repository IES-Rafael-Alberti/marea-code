import {
  createFakeExporter,
  defineTelemetryExporterConformance,
} from "./exporter-conformance.fixture.js";

for (const destination of ["otlp", "langfuse"] as const) {
  defineTelemetryExporterConformance(destination, (scenario) =>
    createFakeExporter("private-adapter-id", {
      export: () => {
        if (scenario === "failure")
          return Promise.reject(new Error("https://private.invalid secret"));
        if (scenario === "export-timeout") return new Promise<void>(() => undefined);
        return Promise.resolve();
      },
      shutdown: () => {
        if (scenario === "shutdown-failure")
          return Promise.reject(new Error("private shutdown secret"));
        return scenario === "shutdown-timeout"
          ? new Promise<void>(() => undefined)
          : Promise.resolve();
      },
    }),
  );
}
