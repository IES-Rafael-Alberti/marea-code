import { describe, expect, it } from "vitest";

import {
  MAX_ATTRIBUTE_COUNT,
  MAX_ATTRIBUTE_KEY_LENGTH,
  MAX_EXPORTER_COUNT,
  MAX_EXPORTER_ID_LENGTH,
  MAX_OPERATION_TIMEOUT_MS,
  MAX_SERVICE_NAME_LENGTH,
  MAX_SERVICE_VERSION_LENGTH,
  type TelemetryDataClassification,
  type TelemetryPipelineOptions,
} from "./contracts.js";
import { TelemetryConfigurationError } from "./errors.js";
import { createTelemetryPipeline } from "./pipeline.js";
import { createFakeExporter, createOptions } from "./telemetry.fixture.js";

function expectConfigurationError(options: TelemetryPipelineOptions, message: string): void {
  expect(() => createTelemetryPipeline(options)).toThrow(new TelemetryConfigurationError(message));
}

describe("telemetry pipeline configuration", () => {
  it("accepts all bounded configuration limits", () => {
    const exporters = Array.from(
      { length: MAX_EXPORTER_COUNT },
      (_, index) => createFakeExporter(`exporter.${String(index)}`).port,
    );
    const allowedAttributeKeys = Array.from(
      { length: MAX_ATTRIBUTE_COUNT },
      (_, index) => `attribute.${String(index)}`,
    );

    expect(() =>
      createTelemetryPipeline({
        ...createOptions(exporters),
        operationTimeoutMs: MAX_OPERATION_TIMEOUT_MS,
        policy: {
          allowedAttributeKeys,
          allowedDataClassifications: ["operational", "pseudonymous", "student-content"],
          redactedAttributeKeys: [allowedAttributeKeys[0] ?? "unreachable"],
        },
        resource: {
          serviceName: `a${"1".repeat(MAX_SERVICE_NAME_LENGTH - 1)}`,
          serviceVersion: "1".repeat(MAX_SERVICE_VERSION_LENGTH),
        },
      }),
    ).not.toThrow();
  });

  it("rejects too many exporters", () => {
    const exporters = Array.from(
      { length: MAX_EXPORTER_COUNT + 1 },
      (_, index) => createFakeExporter(`exporter.${String(index)}`).port,
    );

    expectConfigurationError(
      createOptions(exporters),
      "Too many telemetry exporters are configured.",
    );
  });

  it.each(["", "UPPERCASE", `a${"1".repeat(MAX_EXPORTER_ID_LENGTH)}`])(
    "rejects the exporter id %j",
    (id) => {
      expectConfigurationError(
        createOptions([createFakeExporter(id).port]),
        "Exporter id is invalid.",
      );
    },
  );

  it("rejects duplicate exporter ids", () => {
    expectConfigurationError(
      createOptions([createFakeExporter("duplicate").port, createFakeExporter("duplicate").port]),
      "Exporter ids must be unique.",
    );
  });

  it("rejects too many allowed attribute keys", () => {
    const options = createOptions();

    expectConfigurationError(
      {
        ...options,
        policy: {
          ...options.policy,
          allowedAttributeKeys: Array.from(
            { length: MAX_ATTRIBUTE_COUNT + 1 },
            (_, index) => `attribute.${String(index)}`,
          ),
        },
      },
      "Too many attribute keys are allowed.",
    );
  });

  it.each(["", "UPPERCASE", `a${"1".repeat(MAX_ATTRIBUTE_KEY_LENGTH)}`])(
    "rejects the allowed attribute key %j",
    (key) => {
      const options = createOptions();

      expectConfigurationError(
        {
          ...options,
          policy: { ...options.policy, allowedAttributeKeys: [key] },
        },
        "Allowed attribute key is invalid.",
      );
    },
  );

  it("rejects duplicate allowed attribute keys", () => {
    const options = createOptions();

    expectConfigurationError(
      {
        ...options,
        policy: {
          ...options.policy,
          allowedAttributeKeys: ["course.id", "course.id"],
        },
      },
      "Allowed attribute keys must be unique.",
    );
  });

  it("rejects duplicate allowed data classifications", () => {
    const options = createOptions();

    expectConfigurationError(
      {
        ...options,
        policy: {
          ...options.policy,
          allowedDataClassifications: ["operational", "operational"],
        },
      },
      "Allowed data classifications must be unique.",
    );
  });

  it("rejects an invalid allowed data classification", () => {
    const options = createOptions();

    expectConfigurationError(
      {
        ...options,
        policy: {
          ...options.policy,
          allowedDataClassifications: ["secret" as TelemetryDataClassification],
        },
      },
      "An allowed data classification is invalid.",
    );
  });

  it("rejects an invalid classification alongside a valid classification", () => {
    const options = createOptions();

    expectConfigurationError(
      {
        ...options,
        policy: {
          ...options.policy,
          allowedDataClassifications: ["operational", "secret" as TelemetryDataClassification],
        },
      },
      "An allowed data classification is invalid.",
    );
  });

  it("rejects duplicate redacted attribute keys", () => {
    const options = createOptions();

    expectConfigurationError(
      {
        ...options,
        policy: {
          ...options.policy,
          redactedAttributeKeys: ["course.id", "course.id"],
        },
      },
      "Redacted attribute keys must be unique.",
    );
  });

  it("rejects a redacted attribute outside the allowlist", () => {
    const options = createOptions();

    expectConfigurationError(
      {
        ...options,
        policy: { ...options.policy, redactedAttributeKeys: ["student.prompt"] },
      },
      "Redacted attribute keys must be allowed.",
    );
  });

  it.each(["", "UPPERCASE", `a${"1".repeat(MAX_SERVICE_NAME_LENGTH)}`])(
    "rejects the service name %j",
    (serviceName) => {
      const options = createOptions();

      expectConfigurationError(
        { ...options, resource: { ...options.resource, serviceName } },
        "Service name is invalid.",
      );
    },
  );

  it.each(["", "1".repeat(MAX_SERVICE_VERSION_LENGTH + 1)])(
    "rejects the service version %j",
    (serviceVersion) => {
      const options = createOptions();

      expectConfigurationError(
        { ...options, resource: { ...options.resource, serviceVersion } },
        "Service version is invalid.",
      );
    },
  );

  it.each([0, 1.5, MAX_OPERATION_TIMEOUT_MS + 1])(
    "rejects the operation timeout %s",
    (operationTimeoutMs) => {
      const options = createOptions();

      expectConfigurationError({ ...options, operationTimeoutMs }, "Operation timeout is invalid.");
    },
  );
});
