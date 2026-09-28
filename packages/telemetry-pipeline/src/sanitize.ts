import {
  MAX_ATTRIBUTE_COUNT,
  MAX_ATTRIBUTE_KEY_LENGTH,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  MAX_EVENT_ID_LENGTH,
  MAX_EVENT_NAME_LENGTH,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  type TelemetryAttribute,
  type TelemetryAttributeValue,
  type TelemetryEnvelope,
  type TelemetryEvent,
  type TelemetryEventKind,
  type TelemetryRedactionPolicy,
  type TelemetryResource,
} from "./contracts.js";
import { TelemetryEventValidationError } from "./errors.js";

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const DATA_CLASSIFICATIONS = new Set(["operational", "pseudonymous", "student-content"]);
const EVENT_KINDS: ReadonlySet<TelemetryEventKind> = new Set(["metric", "trace"]);

function assertEventIdentifier(value: string, maximum: number, field: string): void {
  if (value.length === 0 || value.length > maximum) {
    throw new TelemetryEventValidationError(`${field} is invalid.`);
  }
}

function validateAttribute(attribute: TelemetryAttribute): void {
  if (
    attribute.key.length > MAX_ATTRIBUTE_KEY_LENGTH ||
    !ATTRIBUTE_KEY_PATTERN.test(attribute.key)
  ) {
    throw new TelemetryEventValidationError("An attribute key is invalid.");
  }
  if (typeof attribute.value === "number" && !Number.isFinite(attribute.value)) {
    throw new TelemetryEventValidationError("A numeric attribute value is invalid.");
  }
  if (
    typeof attribute.value !== "boolean" &&
    typeof attribute.value !== "number" &&
    typeof attribute.value !== "string"
  ) {
    throw new TelemetryEventValidationError("An attribute value is invalid.");
  }
  if (!DATA_CLASSIFICATIONS.has(attribute.classification)) {
    throw new TelemetryEventValidationError("An attribute classification is invalid.");
  }
}

function validateEvent(event: TelemetryEvent): void {
  assertEventIdentifier(event.id, MAX_EVENT_ID_LENGTH, "Event id");
  assertEventIdentifier(event.name, MAX_EVENT_NAME_LENGTH, "Event name");
  if (!EVENT_NAME_PATTERN.test(event.name)) {
    throw new TelemetryEventValidationError("Event name is invalid.");
  }
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== event.occurredAt) {
    throw new TelemetryEventValidationError("Event timestamp is invalid.");
  }
  if (!EVENT_KINDS.has(event.kind)) {
    throw new TelemetryEventValidationError("Event kind is invalid.");
  }
  if (event.attributes.length > MAX_ATTRIBUTE_COUNT) {
    throw new TelemetryEventValidationError("The event contains too many attributes.");
  }
  for (const attribute of event.attributes) {
    validateAttribute(attribute);
  }
  const keys = event.attributes.map((attribute) => attribute.key);
  if (new Set(keys).size !== keys.length) {
    throw new TelemetryEventValidationError("Event attribute keys must be unique.");
  }
}

function sanitizeValue(
  attribute: TelemetryAttribute,
  redactedKeys: ReadonlySet<string>,
): TelemetryAttributeValue {
  if (redactedKeys.has(attribute.key)) {
    return REDACTED_VALUE;
  }
  return String(attribute.value).length > MAX_ATTRIBUTE_VALUE_LENGTH
    ? TRUNCATED_VALUE
    : attribute.value;
}

export function sanitizeTelemetryEvent(
  event: TelemetryEvent,
  policy: TelemetryRedactionPolicy,
  resource: TelemetryResource,
): TelemetryEnvelope {
  validateEvent(event);
  const allowedClassifications = new Set(policy.allowedDataClassifications);
  const redactedKeys = new Set(policy.redactedAttributeKeys);
  const attributesByKey = new Map(
    event.attributes.map((attribute) => [attribute.key, attribute] as const),
  );
  const attributes = policy.allowedAttributeKeys.flatMap((key) => {
    const attribute = attributesByKey.get(key);
    if (attribute === undefined || !allowedClassifications.has(attribute.classification)) {
      return [];
    }
    return [
      Object.freeze({
        classification: attribute.classification,
        key: attribute.key,
        value: sanitizeValue(attribute, redactedKeys),
      }),
    ];
  });
  return Object.freeze({
    attributes: Object.freeze(attributes),
    eventId: event.id,
    eventName: event.name,
    kind: event.kind,
    occurredAt: event.occurredAt,
    resource,
    schemaVersion: "1.0",
  });
}
