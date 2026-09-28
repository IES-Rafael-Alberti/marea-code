import { describe, expect, it } from "vitest";

import {
  MAX_ATTRIBUTE_COUNT,
  MAX_ATTRIBUTE_KEY_LENGTH,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  MAX_EVENT_ID_LENGTH,
  MAX_EVENT_NAME_LENGTH,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  type TelemetryAttributeValue,
  type TelemetryDataClassification,
  type TelemetryEvent,
  type TelemetryEventKind,
} from "./contracts.js";
import { TelemetryEventValidationError } from "./errors.js";
import { createTelemetryPipeline } from "./pipeline.js";
import { createEvent, createOptions } from "./telemetry.fixture.js";

async function emit(event: TelemetryEvent) {
  const options = createOptions();
  const pipeline = createTelemetryPipeline({
    ...options,
    policy: {
      allowedAttributeKeys: [
        "a.boolean",
        "b.redacted",
        "c.long",
        "course.id",
        "d.number",
        "student.content",
      ],
      allowedDataClassifications: ["operational", "pseudonymous"],
      redactedAttributeKeys: ["b.redacted"],
    },
  });
  return pipeline.emit(event, new AbortController().signal);
}

async function expectEventError(event: TelemetryEvent, message: string): Promise<void> {
  await expect(emit(event)).rejects.toEqual(new TelemetryEventValidationError(message));
}

describe("telemetry sanitization", () => {
  it("allowlists, filters, redacts, bounds, sorts, and freezes an envelope", async () => {
    const report = await emit({
      ...createEvent(),
      attributes: [
        { classification: "operational", key: "c.long", value: "x".repeat(513) },
        { classification: "operational", key: "not.allowed", value: "private" },
        { classification: "operational", key: "b.redacted", value: "secret" },
        { classification: "operational", key: "a.boolean", value: true },
        { classification: "operational", key: "d.number", value: 42 },
        {
          classification: "student-content",
          key: "student.content",
          value: "essay",
        },
      ],
    });

    expect(report.envelope).toEqual({
      attributes: [
        { classification: "operational", key: "a.boolean", value: true },
        {
          classification: "operational",
          key: "b.redacted",
          value: REDACTED_VALUE,
        },
        { classification: "operational", key: "c.long", value: TRUNCATED_VALUE },
        { classification: "operational", key: "d.number", value: 42 },
      ],
      eventId: "event-1",
      eventName: "run.started",
      kind: "trace",
      occurredAt: "2026-09-03T10:00:00.000Z",
      resource: { serviceName: "marea", serviceVersion: "0.0.0" },
      schemaVersion: "1.0",
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.envelope)).toBe(true);
    expect(Object.isFrozen(report.envelope.attributes)).toBe(true);
    expect(Object.isFrozen(report.envelope.attributes[0])).toBe(true);
    expect(Object.isFrozen(report.envelope.resource)).toBe(true);
  });

  it("preserves strings at the value-size limit and sorts ascending input deterministically", async () => {
    const value = "x".repeat(MAX_ATTRIBUTE_VALUE_LENGTH);
    const report = await emit({
      ...createEvent(),
      attributes: [
        { classification: "operational", key: "a.boolean", value: false },
        { classification: "operational", key: "c.long", value },
      ],
    });

    expect(report.envelope.attributes).toEqual([
      { classification: "operational", key: "a.boolean", value: false },
      { classification: "operational", key: "c.long", value },
    ]);
  });

  it.each([
    ["Event id is invalid.", { id: "" }],
    ["Event id is invalid.", { id: "x".repeat(MAX_EVENT_ID_LENGTH + 1) }],
    ["Event name is invalid.", { name: "" }],
    ["Event name is invalid.", { name: "x".repeat(MAX_EVENT_NAME_LENGTH + 1) }],
    ["Event name is invalid.", { name: "UPPERCASE" }],
    ["Event timestamp is invalid.", { occurredAt: "2026-09-03" }],
    ["Event timestamp is invalid.", { occurredAt: "not-a-date" }],
    ["Event kind is invalid.", { kind: "log" as TelemetryEventKind }],
  ] as const)("rejects invalid event metadata: %s", async (message, override) => {
    await expectEventError({ ...createEvent(), ...override }, message);
  });

  it("accepts event metadata at its size limits", async () => {
    await expect(
      emit({
        ...createEvent(),
        id: "x".repeat(MAX_EVENT_ID_LENGTH),
        name: `a${"1".repeat(MAX_EVENT_NAME_LENGTH - 1)}`,
      }),
    ).resolves.toBeDefined();
  });

  it("accepts the maximum number of event attributes", async () => {
    const keys = Array.from(
      { length: MAX_ATTRIBUTE_COUNT },
      (_, index) => `attribute.${String(index)}`,
    );
    const options = createOptions();
    const pipeline = createTelemetryPipeline({
      ...options,
      policy: { ...options.policy, allowedAttributeKeys: keys },
    });

    const report = await pipeline.emit(
      {
        ...createEvent(),
        attributes: keys.map((key) => ({
          classification: "operational",
          key,
          value: true,
        })),
      },
      new AbortController().signal,
    );

    expect(report.envelope.attributes).toHaveLength(MAX_ATTRIBUTE_COUNT);
  });

  it("accepts an event attribute key at the size limit", async () => {
    const key = `a${"1".repeat(MAX_ATTRIBUTE_KEY_LENGTH - 1)}`;
    const options = createOptions();
    const pipeline = createTelemetryPipeline({
      ...options,
      policy: { ...options.policy, allowedAttributeKeys: [key] },
    });

    const report = await pipeline.emit(
      {
        ...createEvent(),
        attributes: [{ classification: "operational", key, value: 1 }],
      },
      new AbortController().signal,
    );

    expect(report.envelope.attributes).toEqual([{ classification: "operational", key, value: 1 }]);
  });

  it("rejects too many event attributes", async () => {
    await expectEventError(
      {
        ...createEvent(),
        attributes: Array.from({ length: MAX_ATTRIBUTE_COUNT + 1 }, (_, index) => ({
          classification: "operational",
          key: `attribute.${String(index)}`,
          value: index,
        })),
      },
      "The event contains too many attributes.",
    );
  });

  it.each(["", "UPPERCASE", `a${"1".repeat(MAX_ATTRIBUTE_KEY_LENGTH)}`])(
    "rejects the event attribute key %j",
    async (key) => {
      await expectEventError(
        {
          ...createEvent(),
          attributes: [{ classification: "operational", key, value: 1 }],
        },
        "An attribute key is invalid.",
      );
    },
  );

  it("rejects a non-finite numeric attribute", async () => {
    await expectEventError(
      {
        ...createEvent(),
        attributes: [{ classification: "operational", key: "course.id", value: Infinity }],
      },
      "A numeric attribute value is invalid.",
    );
  });

  it("rejects an unsupported attribute value", async () => {
    await expectEventError(
      {
        ...createEvent(),
        attributes: [
          {
            classification: "operational",
            key: "course.id",
            value: {} as TelemetryAttributeValue,
          },
        ],
      },
      "An attribute value is invalid.",
    );
  });

  it("rejects an unsupported attribute classification", async () => {
    await expectEventError(
      {
        ...createEvent(),
        attributes: [
          {
            classification: "secret" as TelemetryDataClassification,
            key: "course.id",
            value: "math",
          },
        ],
      },
      "An attribute classification is invalid.",
    );
  });

  it("rejects duplicate event attribute keys", async () => {
    await expectEventError(
      {
        ...createEvent(),
        attributes: [
          { classification: "operational", key: "course.id", value: "math" },
          { classification: "operational", key: "course.id", value: "science" },
        ],
      },
      "Event attribute keys must be unique.",
    );
  });
});
