import type { AuditDispositionInput, AuditOperationInput } from "./audit-storage.js";

export function auditError(message: string): never {
  throw new Error(`SQLite audit state is invalid: ${message}`);
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson }
  | object;
type JsonObject = Record<string, CanonicalJson>;

export function parseJsonValue(value: string): JsonObject {
  let parsed: CanonicalJson;
  try {
    parsed = JSON.parse(value) as CanonicalJson;
  } catch {
    auditError("JSON value");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    auditError("JSON value must be an object");
  return parsed as JsonObject;
}

export function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, CanonicalJson>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => {
      const child = object[key];
      if (child === undefined) auditError("undefined JSON value");
      return `${JSON.stringify(key)}:${canonicalJson(child)}`;
    })
    .join(",")}}`;
}

export function validateOperationInput(operation: AuditOperationInput): void {
  if (operation.state !== "prepared") auditError("new operations must be prepared");
  const artifact = parseJsonValue(operation.artifactJson);
  if (artifact.format === "marea-retention-preview:1") {
    for (const key of [
      "previewId",
      "requestId",
      "authorityLineage",
      "installationId",
      "sourceDatabaseLineage",
      "actorBinding",
      "policyRevision",
      "expectedIndexGeneration",
      "targets",
      "graphDigest",
      "createdAt",
      "expiresAt",
      "artifactDigest",
    ]) {
      if (!Object.hasOwn(artifact, key)) auditError(`artifact ${key} is required`);
    }
    if (artifact.artifactDigest !== operation.artifactDigest)
      auditError("artifact digest does not match operation");
  }
  const bindings: readonly (readonly [string, string | number])[] = [
    ["previewId", operation.operationId],
    ["requestId", operation.requestId],
    ["authorityLineage", operation.authorityLineage],
    ["actorBinding", operation.actorBinding],
    ["policyRevision", operation.policyRevision],
    ["graphDigest", operation.graphDigest],
    ["expectedIndexGeneration", operation.expectedIndexGeneration],
  ];
  for (const [key, expected] of bindings) {
    if (artifact[key] !== expected) auditError(`artifact ${key} does not match operation`);
  }
  if (
    !Number.isSafeInteger(operation.expectedIndexGeneration) ||
    operation.expectedIndexGeneration < 0
  )
    auditError("generation");
}

export function validateDispositions(
  operation: AuditOperationInput,
  dispositions: readonly AuditDispositionInput[],
): void {
  const identities = new Set<string>();
  for (const disposition of dispositions) {
    if (disposition.operationId !== operation.operationId)
      auditError("disposition operation binding");
    if (disposition.targetKind.length === 0 || disposition.logicalKey.length === 0)
      auditError("disposition identity");
    const identity = `${disposition.targetKind}\u0000${disposition.logicalKey}`;
    if (identities.has(identity)) auditError("duplicate disposition");
    identities.add(identity);
    parseJsonValue(disposition.observedJson);
  }
  const targets = parseJsonValue(operation.artifactJson).targets;
  if (!Array.isArray(targets) || targets.length !== dispositions.length)
    auditError("disposition target count");
  const targetIdentities = new Set<string>();
  for (const target of targets as readonly CanonicalJson[]) {
    const { kind, key } = (target ?? {}) as Partial<Record<string, CanonicalJson>>;
    if (typeof kind !== "string" || key === null || typeof key !== "object")
      auditError("disposition target identity");
    const identity = `${kind}\u0000${canonicalJson({ kind, key })}`;
    if (targetIdentities.has(identity)) auditError("duplicate disposition target");
    targetIdentities.add(identity);
    if (!identities.has(identity)) auditError("disposition target set");
  }
}
