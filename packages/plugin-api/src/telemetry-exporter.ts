import type { TelemetryExporterFactory } from "./telemetry-factory.js";
import * as z from "zod";

import {
  createCommonManifestShape,
  hasSafeRelationships,
  safeRelationshipMessage,
} from "./manifest-fields.js";

export function createTelemetryExporterManifestSchema() {
  return z
    .object({
      ...createCommonManifestShape(),
      kind: z.literal("telemetry-exporter"),
      apiVersion: z.literal("1.0"),
      capabilities: z
        .array(z.enum(["batch-export", "metric-export", "trace-export"]))
        .min(1)
        .refine((values) => new Set(values).size === values.length, "Capabilities must be unique.")
        .readonly(),
      runtimeTargets: z.tuple([z.literal("teacher-server")]).readonly(),
      acceptedDataClassifications: z
        .array(z.enum(["operational", "pseudonymous", "student-content"]))
        .min(1)
        .refine(
          (values) => new Set(values).size === values.length,
          "Data classifications must be unique.",
        )
        .readonly(),
      destination: z.enum(["local", "external"]),
    })
    .strict()
    .refine(hasSafeRelationships, safeRelationshipMessage())
    .readonly();
}

export type TelemetryExporterManifest = z.infer<
  ReturnType<typeof createTelemetryExporterManifestSchema>
>;

export interface TelemetryExporterCatalogEntry {
  readonly manifest: TelemetryExporterManifest;
  /** Optional for existing manifest-only entries; absence means not executable. */
  readonly implementation?:
    | { readonly destination: "otlp"; readonly create: TelemetryExporterFactory<"otlp"> }
    | { readonly destination: "langfuse"; readonly create: TelemetryExporterFactory<"langfuse"> };
}

export function defineTelemetryExporterCatalogEntry(
  entry: TelemetryExporterCatalogEntry,
): TelemetryExporterCatalogEntry {
  return entry;
}
