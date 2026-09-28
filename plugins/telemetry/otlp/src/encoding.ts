import {
  TelemetryExporterError,
  type TelemetryEnvelope,
  type TelemetryAttributeValue,
} from "@marea/plugin-api";

function measurement(value: TelemetryAttributeValue) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TelemetryExporterError("unavailable");
    return { asDouble: value };
  }
  if (typeof value === "boolean") return { asInt: value ? "1" : "0" };
  // A centrally redacted string is not a numeric zero: OTLP's no-recorded-value flag.
  return { flags: 1, asInt: "0" };
}

export function encodeMetrics(envelope: TelemetryEnvelope): Uint8Array<ArrayBuffer> {
  if (envelope.kind !== "metric") throw new TelemetryExporterError("unavailable");
  const millis = Date.parse(envelope.occurredAt);
  // Largest whole millisecond representable as uint64 nanoseconds.
  if (millis <= 0 || millis > 18_446_744_073_709) throw new TelemetryExporterError("unavailable");
  const timestamp = BigInt(millis) * 1_000_000n;
  return new TextEncoder().encode(
    JSON.stringify({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: envelope.resource.serviceName } },
              { key: "service.version", value: { stringValue: envelope.resource.serviceVersion } },
            ],
          },
          scopeMetrics: [
            {
              metrics: envelope.attributes.map(({ key, value }) => ({
                name: `${envelope.eventName}.${key}`,
                unit: key === "operation.duration-ms" ? "ms" : "1",
                gauge: {
                  dataPoints: [{ timeUnixNano: timestamp.toString(), ...measurement(value) }],
                },
              })),
            },
          ],
        },
      ],
    }),
  );
}
