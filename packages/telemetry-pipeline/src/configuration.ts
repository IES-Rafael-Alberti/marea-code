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

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const DATA_CLASSIFICATIONS: readonly TelemetryDataClassification[] = [
  "operational",
  "pseudonymous",
  "student-content",
];

function assertBoundedIdentifier(value: string, maximum: number, field: string): void {
  if (value.length > maximum || !IDENTIFIER_PATTERN.test(value)) {
    throw new TelemetryConfigurationError(`${field} is invalid.`);
  }
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new TelemetryConfigurationError(`${field} must be unique.`);
  }
}

function validateExporterIds(options: TelemetryPipelineOptions): void {
  if (options.exporters.length > MAX_EXPORTER_COUNT) {
    throw new TelemetryConfigurationError("Too many telemetry exporters are configured.");
  }
  const exporterIds = options.exporters.map((exporter) => exporter.id);
  for (const exporterId of exporterIds) {
    assertBoundedIdentifier(exporterId, MAX_EXPORTER_ID_LENGTH, "Exporter id");
  }
  assertUnique(exporterIds, "Exporter ids");
}

function validatePolicy(options: TelemetryPipelineOptions): void {
  const { allowedAttributeKeys, allowedDataClassifications, redactedAttributeKeys } =
    options.policy;
  if (allowedAttributeKeys.length > MAX_ATTRIBUTE_COUNT) {
    throw new TelemetryConfigurationError("Too many attribute keys are allowed.");
  }
  for (const key of allowedAttributeKeys) {
    assertBoundedIdentifier(key, MAX_ATTRIBUTE_KEY_LENGTH, "Allowed attribute key");
  }
  assertUnique(allowedAttributeKeys, "Allowed attribute keys");
  assertUnique(allowedDataClassifications, "Allowed data classifications");
  if (
    allowedDataClassifications.some(
      (classification) => !DATA_CLASSIFICATIONS.includes(classification),
    )
  ) {
    throw new TelemetryConfigurationError("An allowed data classification is invalid.");
  }
  assertUnique(redactedAttributeKeys, "Redacted attribute keys");
  const allowedKeys = new Set(allowedAttributeKeys);
  if (redactedAttributeKeys.some((key) => !allowedKeys.has(key))) {
    throw new TelemetryConfigurationError("Redacted attribute keys must be allowed.");
  }
}

function validateResource(options: TelemetryPipelineOptions): void {
  assertBoundedIdentifier(options.resource.serviceName, MAX_SERVICE_NAME_LENGTH, "Service name");
  if (
    options.resource.serviceVersion.length === 0 ||
    options.resource.serviceVersion.length > MAX_SERVICE_VERSION_LENGTH
  ) {
    throw new TelemetryConfigurationError("Service version is invalid.");
  }
}

export function validateTelemetryPipelineOptions(options: TelemetryPipelineOptions): void {
  validateExporterIds(options);
  validatePolicy(options);
  validateResource(options);
  if (
    !Number.isInteger(options.operationTimeoutMs) ||
    options.operationTimeoutMs < 1 ||
    options.operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS
  ) {
    throw new TelemetryConfigurationError("Operation timeout is invalid.");
  }
}
