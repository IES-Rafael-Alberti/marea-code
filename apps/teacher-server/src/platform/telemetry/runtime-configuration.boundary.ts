import { z } from "zod";
import { createTelemetryExporterConfigurationSchema } from "@marea/plugin-api";

/** Private administrator input in teacher-host.json; never exposed over HTTP. */
export function telemetryRuntimeConfigurationSchema() {
  return z
    .object({
      enabled: z.boolean(),
      startupTimeoutMs: z.number().int().min(1).max(30_000),
      maxInFlight: z.number().int().min(1).max(32),
      exporters: z.array(createTelemetryExporterConfigurationSchema()).max(2),
    })
    .strict()
    .readonly();
}
