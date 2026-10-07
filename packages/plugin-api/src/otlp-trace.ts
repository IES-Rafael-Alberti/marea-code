import type { SessionTrace, SessionTraceSpan } from "./session-traces.js";

export interface OtlpStringAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}
export const otlpString = (key: string, value: string): OtlpStringAttribute => ({
  key,
  value: { stringValue: value },
});
export function traceTimestamp(date: string): string {
  const value = Date.parse(date);
  if (!Number.isSafeInteger(value) || value < 0 || value > 18_446_744_073_709)
    throw new RangeError("Invalid trace timestamp.");
  return (BigInt(value) * 1_000_000n).toString();
}
/** OTLP/HTTP JSON mapping shared by exporters; vendor attributes belong to their plugin. */
export function encodeSessionTrace(
  trace: SessionTrace,
  attributes: (span: SessionTraceSpan) => readonly OtlpStringAttribute[] = () => [],
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              otlpString("service.name", "marea-teacher"),
              otlpString("service.version", trace.release),
            ],
          },
          scopeSpans: [
            {
              scope: { name: "marea.sessions", version: "1" },
              spans: trace.spans.map((span) => ({
                traceId: trace.id,
                spanId: span.id,
                parentSpanId: span.parentId,
                name: span.name,
                kind: 1,
                startTimeUnixNano: traceTimestamp(span.startedAt),
                ...(span.endedAt === undefined
                  ? {}
                  : { endTimeUnixNano: traceTimestamp(span.endedAt) }),
                status: { code: span.failed ? 2 : 1 },
                attributes: [
                  otlpString("session.id", trace.sessionId),
                  otlpString("user.id", trace.userId),
                  otlpString("marea.class.id", trace.classId),
                  otlpString("gen_ai.input.messages", span.input),
                  otlpString("gen_ai.output.messages", span.output),
                  otlpString("marea.metadata", JSON.stringify(span.metadata)),
                  ...(span.model === undefined
                    ? []
                    : [otlpString("gen_ai.request.model", span.model)]),
                  ...(span.usage === undefined
                    ? []
                    : [
                        {
                          key: "gen_ai.usage.input_tokens",
                          value: { intValue: String(span.usage.input) },
                        },
                        {
                          key: "gen_ai.usage.output_tokens",
                          value: { intValue: String(span.usage.output) },
                        },
                      ]),
                  ...attributes(span),
                ],
              })),
            },
          ],
        },
      ],
    }),
  );
}
