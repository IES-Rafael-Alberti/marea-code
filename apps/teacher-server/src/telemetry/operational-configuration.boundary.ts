import * as z from "zod";
import {
  DISABLED_OPERATIONAL_TELEMETRY,
  TelemetryConfigurationError,
  type OperationalTelemetryConfiguration,
} from "@marea/telemetry-pipeline";

const configurationSchema = z
  .object({
    enabled: z.boolean(),
    destinations: z
      .array(z.enum(["otlp", "langfuse"]))
      .max(2)
      .readonly(),
    operationTimeoutMs: z.number().int().min(1).max(30_000),
    maxInFlight: z.number().int().min(1).max(32),
  })
  .strict()
  .readonly();

/** Deployment input only. Parse errors must not echo configuration or future secrets. */
export function parseOperationalTelemetryConfiguration(
  input: unknown,
): OperationalTelemetryConfiguration {
  if (input === undefined) return DISABLED_OPERATIONAL_TELEMETRY;
  const parsed = configurationSchema.safeParse(input);
  if (!parsed.success)
    throw new TelemetryConfigurationError("Operational telemetry configuration is invalid.");
  return parsed.data;
}
