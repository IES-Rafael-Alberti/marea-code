import { vi } from "vitest";
import type {
  TelemetryExporterCatalogEntry,
  TelemetryExporterConnections,
  TelemetryExporterCredentialResolver,
  TelemetryExporterDestination,
} from "@marea/plugin-api";
import { createFakeExporter } from "@marea/telemetry-pipeline/testing";

export function runtimeFixture() {
  const otlp = createFakeExporter("private:otlp");
  const langfuse = createFakeExporter("private:langfuse");
  const connections: TelemetryExporterConnections = {
    otlp: { endpoint: "https://collector.invalid", headers: { authorization: "synthetic-secret" } },
    langfuse: {
      endpoint: "https://langfuse.invalid",
      publicKey: "synthetic-public",
      secretKey: "synthetic-secret",
    },
  };
  const resolve = vi.fn(
    <D extends TelemetryExporterDestination>(
      destination: D,
      _signal: AbortSignal,
    ): Promise<TelemetryExporterConnections[D]> => {
      _signal.throwIfAborted();
      return Promise.resolve(connections[destination]);
    },
  );
  const resolver: TelemetryExporterCredentialResolver = {
    resolve: resolve as TelemetryExporterCredentialResolver["resolve"],
  };
  const createOtlp = vi.fn(() => otlp.port);
  const createLangfuse = vi.fn(() => langfuse.port);
  const manifest = {
    id: "telemetry.synthetic",
    kind: "telemetry-exporter",
    apiVersion: "1.0",
    implementationVersion: "1.0.0",
    displayNameKey: "plugin.synthetic.name",
    descriptionKey: "plugin.synthetic.description",
    entrypoint: "./index.ts",
    configurationVersion: 1,
    requiredDependencies: [],
    optionalDependencies: [],
    conflicts: [],
    capabilities: ["metric-export"],
    runtimeTargets: ["teacher-server"],
    acceptedDataClassifications: ["operational"],
    destination: "external",
  } as const;
  const catalog: readonly TelemetryExporterCatalogEntry[] = [
    { manifest, implementation: { destination: "otlp", create: createOtlp } },
    { manifest, implementation: { destination: "langfuse", create: createLangfuse } },
  ];
  const configuration = {
    enabled: true,
    startupTimeoutMs: 20,
    maxInFlight: 1,
    exporters: (["otlp", "langfuse"] as const).map((destination) => ({
      destination,
      schemaVersion: "1.0" as const,
      operationTimeoutMs: 10,
      maxRequestBytes: 4096,
      maxResponseBytes: 1024,
    })),
  };
  return {
    configuration,
    catalog,
    resolver,
    resolve,
    createOtlp,
    createLangfuse,
    otlp,
    langfuse,
    signal: new AbortController().signal,
    connections,
  };
}
export const syntheticOperation = {
  id: "synthetic-private-id",
  name: "synthetic-private-name",
  kind: "metric" as const,
  occurredAt: "2026-09-22T00:00:00.000Z",
  attributes: [{ key: "operation.succeeded", value: true, classification: "operational" as const }],
};
