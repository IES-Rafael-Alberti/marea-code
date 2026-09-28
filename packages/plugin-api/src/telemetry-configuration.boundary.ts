import * as z from "zod";
import {
  TelemetryExporterError,
  type TelemetryExporterConfiguration,
} from "./telemetry-factory.js";

export function createTelemetryExporterConfigurationSchema() {
  return z
    .object({
      destination: z.enum(["otlp", "langfuse"]),
      schemaVersion: z.literal("1.0"),
      operationTimeoutMs: z.number().int().min(1).max(30_000),
      maxRequestBytes: z.number().int().min(1).max(262_144),
      maxResponseBytes: z.number().int().min(1).max(65_536),
    })
    .strict()
    .readonly();
}

/** Validate untrusted operator input without exposing Zod diagnostics or rejected values. */
export function parseTelemetryExporterConfiguration(
  input: unknown,
): TelemetryExporterConfiguration {
  const result = createTelemetryExporterConfigurationSchema().safeParse(input);
  if (!result.success) throw new TelemetryExporterError("invalid-configuration");
  return result.data;
}
