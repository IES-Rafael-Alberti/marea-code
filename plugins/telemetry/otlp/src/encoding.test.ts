import { expect, it } from "vitest";
import { encodeMetrics } from "./encoding.js";
import { sample } from "./otlp.fixture.js";

it("encodes operational gauges with exact nanoseconds, units and resource without identifiers", () => {
  expect(JSON.parse(new TextDecoder().decode(encodeMetrics(sample)))).toEqual({
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "marea-teacher" } },
            { key: "service.version", value: { stringValue: "1.0" } },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "operation.completed.operation.duration-ms",
                unit: "ms",
                gauge: { dataPoints: [{ timeUnixNano: "1790071200123000000", asDouble: 125.5 }] },
              },
              {
                name: "operation.completed.operation.succeeded",
                unit: "1",
                gauge: { dataPoints: [{ timeUnixNano: "1790071200123000000", asInt: "1" }] },
              },
            ],
          },
        ],
      },
    ],
  });
});
it.each([
  [false, { asInt: "0" }],
  ["[redacted]", { flags: 1, asInt: "0" }],
] as const)("preserves false and missing numeric data", (value, expected) => {
  const body = new TextDecoder().decode(
    encodeMetrics({
      ...sample,
      attributes: [{ key: "operation.succeeded", classification: "operational", value }],
    }),
  );
  expect(body).toContain(JSON.stringify(expected).slice(1, -1));
});
it.each([0, -1, 18446744073710])(
  "rejects timestamps outside positive uint64 nanoseconds",
  (millis) => {
    expect(() =>
      encodeMetrics({ ...sample, occurredAt: new Date(millis).toISOString() }),
    ).toThrow();
  },
);
it("rejects unsupported traces and nonfinite measurements", () => {
  expect(() => encodeMetrics({ ...sample, kind: "trace" })).toThrow();
  expect(() =>
    encodeMetrics({
      ...sample,
      attributes: [
        { key: "operation.duration-ms", classification: "operational", value: Infinity },
      ],
    }),
  ).toThrow();
});
it("accepts the largest representable whole millisecond and reports safe mapping errors", () => {
  expect(
    new TextDecoder().decode(
      encodeMetrics({ ...sample, occurredAt: new Date(18446744073709).toISOString() }),
    ),
  ).toContain('"timeUnixNano":"18446744073709000000"');
  for (const envelope of [
    { ...sample, occurredAt: new Date(0).toISOString() },
    {
      ...sample,
      attributes: [
        { key: "operation.duration-ms", classification: "operational" as const, value: NaN },
      ],
    },
  ])
    expect(() => encodeMetrics(envelope)).toThrow(expect.objectContaining({ code: "unavailable" }));
});
