import { expect, it } from "vitest";
import { encodeSessionTrace, traceTimestamp, otlpString } from "./otlp-trace.js";
import { sessionTraceEnvelope } from "./trace-envelope.js";
import { sessionTraceFixture as trace } from "./session-trace.fixture.js";
it("encodes linked OTLP spans, semantic content, exact timestamps and numeric token counts", () => {
  expect(otlpString("field", "text")).toEqual({ key: "field", value: { stringValue: "text" } });
  const bytes = encodeSessionTrace(trace);
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
    resourceSpans: [
      {
        resource: {
          attributes: [
            otlpString("service.name", "marea-teacher"),
            otlpString("service.version", "preview-test"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "marea.sessions", version: "1" },
            spans: [
              {
                traceId: trace.id,
                spanId: "b".repeat(16),
                name: "Turn",
                kind: 1,
                startTimeUnixNano: "1791417600000000000",
                endTimeUnixNano: "1791417601000000000",
                status: { code: 1 },
                attributes: [
                  otlpString("session.id", "session-hash"),
                  otlpString("user.id", "student-hash"),
                  otlpString("marea.class.id", "class-hash"),
                  otlpString("gen_ai.input.messages", "Student question"),
                  otlpString("gen_ai.output.messages", "Tutor answer"),
                  otlpString("marea.metadata", '{"complete":true}'),
                ],
              },
              {
                traceId: trace.id,
                spanId: "c".repeat(16),
                parentSpanId: "b".repeat(16),
                name: "Model",
                kind: 1,
                startTimeUnixNano: "1791417600100000000",
                endTimeUnixNano: "1791417600900000000",
                status: { code: 2 },
                attributes: [
                  otlpString("session.id", "session-hash"),
                  otlpString("user.id", "student-hash"),
                  otlpString("marea.class.id", "class-hash"),
                  otlpString("gen_ai.input.messages", '[{"role":"user","content":"Question"}]'),
                  otlpString("gen_ai.output.messages", "Answer"),
                  otlpString("marea.metadata", '{"attempt":1}'),
                  otlpString("gen_ai.request.model", "model-name"),
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "8" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(
    new TextDecoder().decode(encodeSessionTrace(trace, () => [otlpString("custom", "value")])),
  ).toContain('"key":"custom"');
  expect(sessionTraceEnvelope(trace)).toEqual({
    trace,
    schemaVersion: "1.0",
    eventId: trace.id,
    eventName: "session.turn",
    kind: "trace",
    occurredAt: "2026-10-08T00:00:00.000Z",
    resource: { serviceName: "marea-teacher", serviceVersion: "preview-test" },
    attributes: [],
  });
  expect(() => sessionTraceEnvelope({ ...trace, spans: [] })).toThrow(
    expect.objectContaining({ code: "invalid-configuration" }),
  );
  const unfinished = encodeSessionTrace({
    ...trace,
    spans: trace.spans.map((s) => ({ ...s, endedAt: undefined })),
  });
  expect(new TextDecoder().decode(unfinished)).not.toContain("endTimeUnixNano");
});
it("rejects invalid or unrepresentable OTLP timestamps and accepts the uint64 millisecond boundary", () => {
  expect(traceTimestamp("1970-01-01T00:00:00.000Z")).toBe("0");
  expect(traceTimestamp(new Date(18_446_744_073_709).toISOString())).toBe("18446744073709000000");
  for (const value of [
    "invalid",
    "1969-12-31T23:59:59.999Z",
    new Date(18_446_744_073_710).toISOString(),
  ])
    expect(() => traceTimestamp(value)).toThrow("Invalid trace timestamp");
});
