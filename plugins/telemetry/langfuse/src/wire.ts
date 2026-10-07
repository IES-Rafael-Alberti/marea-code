import type { TelemetryEnvelope } from "@marea/plugin-api";
import { encodeSessionTrace, otlpString } from "@marea/plugin-api";

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** A point observation carrying the intact metric, not an inferred duration or LLM trace. */
export function encodeEnvelope(envelope: TelemetryEnvelope): Uint8Array<ArrayBuffer> {
  const trace = envelope.trace;
  if (trace !== undefined)
    return encodeSessionTrace(trace, (span) => [
      otlpString("langfuse.session.id", trace.sessionId),
      otlpString("langfuse.user.id", trace.userId),
      otlpString("langfuse.release", trace.release),
      otlpString("langfuse.trace.name", "Marea tutoring turn"),
      otlpString("langfuse.trace.metadata.classId", trace.classId),
      otlpString("langfuse.observation.type", span.type),
      otlpString("langfuse.observation.input", span.input),
      otlpString("langfuse.observation.output", span.output),
      otlpString("langfuse.observation.metadata", JSON.stringify(span.metadata)),
      ...(span.model === undefined
        ? []
        : [otlpString("langfuse.observation.model.name", span.model)]),
      ...(span.usage === undefined
        ? []
        : [otlpString("langfuse.observation.usage_details", JSON.stringify(span.usage))]),
    ]);
  const milliseconds = Date.parse(envelope.occurredAt);
  // OTLP timestamps are uint64 nanoseconds; reject unrepresentable dates.
  if (milliseconds < 0 || milliseconds > 18_446_744_073_709) throw new RangeError();
  const timestamp = (BigInt(milliseconds) * 1_000_000n).toString();
  const traceId = crypto.randomUUID().replaceAll("-", "");
  const spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return new TextEncoder().encode(
    JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              attribute("service.name", envelope.resource.serviceName),
              attribute("service.version", envelope.resource.serviceVersion),
            ],
          },
          scopeSpans: [
            {
              scope: { name: "org.marea.langfuse", version: "1.0" },
              spans: [
                {
                  traceId,
                  spanId,
                  name: envelope.eventName,
                  kind: 1,
                  startTimeUnixNano: timestamp,
                  endTimeUnixNano: timestamp,
                  attributes: [
                    attribute("langfuse.observation.type", "event"),
                    attribute("langfuse.observation.metadata.marea", JSON.stringify(envelope)),
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
}
