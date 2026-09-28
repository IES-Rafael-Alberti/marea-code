import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

import { Sha256DigestSchema, UtcTimestampSchema, type Sha256Digest } from "@marea/protocol";

import { PreviewArtifactSchema, type PreviewArtifact } from "./schemas.js";

export const MAX_ARTIFACT_BYTES = 256 * 1_024;
export const MAX_INPUT_BYTES = 64 * 1_024;
export const MAX_TARGETS = 1_000;
export const MAX_GRAPH_NODES = 10_000;
export const MAX_CANONICAL_DEPTH = 64;
export const PREVIEW_LIFETIME_MS = 10 * 60 * 1_000;
export const MAX_DRAIN_MS = 15 * 60 * 1_000;

export class OperationsBoundaryError extends Error {
  public constructor(
    public readonly code:
      "invalid-input" | "limit" | "stale-preview" | "uncertain" | "blocked-reference",
    message: string,
  ) {
    super(message);
    this.name = "OperationsBoundaryError";
    this.safeMessage = message;
  }

  public readonly safeMessage: string;
}

type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function canonical(
  value: unknown,
  seen: Set<object>,
  nodes: { value: number },
  depth = 0,
): JsonValue {
  if (depth > MAX_CANONICAL_DEPTH)
    throw new OperationsBoundaryError("limit", "canonical value depth limit exceeded");
  nodes.value += 1;
  if (nodes.value > MAX_GRAPH_NODES)
    throw new OperationsBoundaryError("limit", "canonical value node limit exceeded");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new OperationsBoundaryError("invalid-input", "non-finite number is not valid JSON");
    return value;
  }
  if (typeof value !== "object")
    throw new OperationsBoundaryError("invalid-input", "unsupported JSON value");
  if (seen.has(value)) throw new OperationsBoundaryError("invalid-input", "cyclic JSON value");
  seen.add(value);
  const result = Array.isArray(value)
    ? canonicalArray(value, seen, nodes, depth)
    : canonicalObject(value, seen, nodes, depth);
  seen.delete(value);
  return result;
}

function canonicalArray(
  value: readonly unknown[],
  seen: Set<object>,
  nodes: { value: number },
  depth: number,
): JsonValue[] {
  const entries: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index))
      throw new OperationsBoundaryError("invalid-input", "sparse JSON array");
    entries.push(canonical(value[index], seen, nodes, depth + 1));
  }
  return entries;
}

function canonicalObject(
  value: object,
  seen: Set<object>,
  nodes: { value: number },
  depth: number,
): Record<string, JsonValue> {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new OperationsBoundaryError("invalid-input", "unsupported JSON object");
  const record = value as Record<string, unknown>;
  const output = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined)
      throw new OperationsBoundaryError("invalid-input", "undefined JSON value");
    Object.defineProperty(output, key, {
      enumerable: true,
      value: canonical(record[key], seen, nodes, depth + 1),
    });
  }
  return output;
}

export function canonicalJsonBytes(
  value: unknown,
  maximumBytes: number = MAX_ARTIFACT_BYTES,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonical(value, new Set<object>(), { value: 0 })),
  );
  if (bytes.byteLength > maximumBytes)
    throw new OperationsBoundaryError("limit", "canonical JSON byte limit exceeded");
  return bytes;
}

export function protocolDigest(bytes: Uint8Array): Sha256Digest {
  return Sha256DigestSchema.parse(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

export function artifactDigest(
  artifact: Omit<PreviewArtifact, "artifactDigest">,
): PreviewArtifact["artifactDigest"] {
  return protocolDigest(canonicalJsonBytes(canonicalArtifactValue(artifact)));
}

export function encodeArtifact(artifact: PreviewArtifact): Uint8Array {
  const parsed = PreviewArtifactSchema.parse(artifact);
  assertUniqueTargets(parsed.targets);
  const withoutDigest = { ...parsed } as Omit<PreviewArtifact, "artifactDigest">;
  delete (withoutDigest as { artifactDigest?: unknown }).artifactDigest;
  const expected = artifactDigest(withoutDigest);
  if (expected !== parsed.artifactDigest)
    throw new OperationsBoundaryError("invalid-input", "artifact digest mismatch");
  return canonicalJsonBytes(canonicalArtifactValue(parsed));
}

function decodeUtf8(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES)
    throw new OperationsBoundaryError("limit", "artifact byte limit exceeded");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OperationsBoundaryError("invalid-input", "artifact is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OperationsBoundaryError("invalid-input", "artifact JSON is invalid");
  }
}

export function parseArtifact(bytes: Uint8Array): PreviewArtifact {
  let parsed: PreviewArtifact;
  try {
    parsed = PreviewArtifactSchema.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof OperationsBoundaryError) throw error;
    throw new OperationsBoundaryError("invalid-input", "artifact schema is invalid");
  }
  const withoutDigest = { ...parsed } as Omit<PreviewArtifact, "artifactDigest">;
  delete (withoutDigest as { artifactDigest?: unknown }).artifactDigest;
  if (artifactDigest(withoutDigest) !== parsed.artifactDigest) {
    throw new OperationsBoundaryError("invalid-input", "artifact digest mismatch");
  }
  assertUniqueTargets(parsed.targets);
  const canonicalBytes = canonicalJsonBytes(canonicalArtifactValue(parsed));
  if (!bytesEqual(canonicalBytes, bytes)) {
    throw new OperationsBoundaryError("invalid-input", "artifact is not canonical JSON");
  }
  return parsed;
}

function assertUniqueTargets(targets: readonly PreviewArtifact["targets"][number][]): void {
  const seen = new Set<string>();
  for (const target of targets) {
    const identity = new TextDecoder().decode(
      canonicalJsonBytes({ kind: target.kind, key: target.key }, MAX_INPUT_BYTES),
    );
    if (seen.has(identity))
      throw new OperationsBoundaryError("invalid-input", "duplicate target identity");
    seen.add(identity);
  }
}

export function parseBoundedJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_INPUT_BYTES)
    throw new OperationsBoundaryError("limit", "input byte limit exceeded");
  const value = decodeUtf8(bytes);
  // Parse once through the bounded canonical encoder as well. JSON.parse alone
  // would accept arbitrarily deep/node-heavy structures before schema parsing.
  canonicalJsonBytes(value, MAX_INPUT_BYTES);
  return value;
}

function canonicalArtifactValue<
  T extends { targets: readonly PreviewArtifact["targets"][number][] },
>(artifact: T): T {
  const targets = [...artifact.targets].sort((left, right) => {
    const kindComparison = compareCanonicalText(left.kind, right.kind);
    if (kindComparison !== 0) return kindComparison;
    const leftKey = new TextDecoder().decode(
      canonicalJsonBytes({ kind: left.kind, key: left.key }, MAX_INPUT_BYTES),
    );
    const rightKey = new TextDecoder().decode(
      canonicalJsonBytes({ kind: right.kind, key: right.key }, MAX_INPUT_BYTES),
    );
    return compareCanonicalText(leftKey, rightKey);
  });
  return { ...artifact, targets };
}

function compareCanonicalText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function isPreviewExpired(artifact: PreviewArtifact, now: string): boolean {
  const nowMillis = validTimestamp(now);
  const createdMillis = validTimestamp(artifact.createdAt);
  const expiresMillis = validTimestamp(artifact.expiresAt);
  if (![nowMillis, createdMillis, expiresMillis].every(Number.isFinite)) return true;
  if (nowMillis < createdMillis) return true;
  if (nowMillis >= expiresMillis) return true;
  return expiresMillis - createdMillis !== PREVIEW_LIFETIME_MS;
}

export function isDrainExpired(drainUntil: string, startedAt: string): boolean {
  const drainMillis = validTimestamp(drainUntil);
  const startedMillis = validTimestamp(startedAt);
  if (![drainMillis, startedMillis].every(Number.isFinite)) return true;
  const delta = drainMillis - startedMillis;
  return delta < 0 || delta > MAX_DRAIN_MS;
}

function validTimestamp(value: string): number {
  const parsed = UtcTimestampSchema.safeParse(value);
  return parsed.success ? Date.parse(value) : Number.NaN;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
