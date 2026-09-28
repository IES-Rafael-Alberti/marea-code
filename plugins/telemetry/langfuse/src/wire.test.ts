import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { encodeEnvelope } from "./wire.js";
import { envelope } from "./exporter.fixture.js";

afterEach(() => vi.restoreAllMocks());
it("encodes an exact OTLP point event, with no fabricated measurement interval", () => {
  vi.spyOn(crypto, "randomUUID")
    .mockReturnValueOnce("11111111-2222-4333-8444-555555555555")
    .mockReturnValueOnce("66666666-7777-4888-8999-aaaaaaaaaaaa");
  const bytes = encodeEnvelope(envelope);
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "marea-code" } },
            { key: "service.version", value: { stringValue: "1.0" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "org.marea.langfuse", version: "1.0" },
            spans: [
              {
                traceId: "11111111222243338444555555555555",
                spanId: "6666666677774888",
                name: "operation.completed",
                kind: 1,
                startTimeUnixNano: "1790071200123000000",
                endTimeUnixNano: "1790071200123000000",
                attributes: [
                  { key: "langfuse.observation.type", value: { stringValue: "event" } },
                  {
                    key: "langfuse.observation.metadata.marea",
                    value: { stringValue: JSON.stringify(envelope) },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
});
it("keeps executable and discoverable manifest metadata identical", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
  ) as object;
  expect(plugin.manifest).toEqual({
    ...manifest,
    requiredDependencies: [],
    optionalDependencies: [],
    conflicts: [],
  });
});

it.each([-1, 18_446_744_073_710])(
  "rejects dates outside OTLP uint64 nanoseconds: %i",
  (milliseconds) => {
    expect(() =>
      encodeEnvelope({ ...envelope, occurredAt: new Date(milliseconds).toISOString() }),
    ).toThrow(RangeError);
  },
);
it.each([0, 18_446_744_073_709])("accepts representable edge timestamp %i", (milliseconds) => {
  expect(
    new TextDecoder().decode(
      encodeEnvelope({ ...envelope, occurredAt: new Date(milliseconds).toISOString() }),
    ),
  ).toContain(`"startTimeUnixNano":"${(BigInt(milliseconds) * 1_000_000n).toString()}"`);
});
