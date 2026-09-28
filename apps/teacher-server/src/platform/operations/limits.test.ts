import { describe, expect, it } from "vitest";

import {
  MAX_CANONICAL_DEPTH,
  MAX_INPUT_BYTES,
  OperationsBoundaryError,
  isDrainExpired,
  isPreviewExpired,
  parseBoundedJson,
  canonicalJsonBytes,
} from "./canonical-encoder.js";
import { PreviewArtifactSchema } from "./schemas.js";

const digest = `sha256:${"a".repeat(64)}`;
const artifact = PreviewArtifactSchema.parse({
  format: "marea-retention-preview:1",
  previewId: "preview-1",
  requestId: "request-1",
  authorityLineage: "lineage-1",
  installationId: "root-1",
  sourceDatabaseLineage: digest,
  actorBinding: "exclusive-installation-owner",
  policyRevision: "policy-1",
  expectedIndexGeneration: 2,
  targets: [
    { kind: "account", key: { userId: "user-1" }, observed: { kind: "version", version: "v1" } },
  ],
  graphDigest: digest,
  counts: { rows: 1, files: 0, backups: 0 },
  bytes: { database: 0, files: 0, backups: 0 },
  blockers: [],
  createdAt: "2026-09-12T10:00:00Z",
  expiresAt: "2026-09-12T10:10:00Z",
  artifactDigest: digest,
});

describe("OPERATIONS time bounds", () => {
  it("enforces exact preview lifetime and drain deadline", () => {
    expect(isPreviewExpired(artifact, "2026-09-12T10:09:59Z")).toBe(false);
    expect(isPreviewExpired(artifact, artifact.createdAt)).toBe(false);
    expect(isPreviewExpired(artifact, "2026-09-12T10:10:00Z")).toBe(true);
    expect(isPreviewExpired(artifact, "2026-09-12T09:59:59Z")).toBe(true);
    expect(isPreviewExpired({ ...artifact, createdAt: "invalid" }, artifact.createdAt)).toBe(true);
    expect(isPreviewExpired({ ...artifact, expiresAt: "invalid" }, artifact.createdAt)).toBe(true);
    expect(isPreviewExpired(artifact, "invalid")).toBe(true);
    expect(
      isPreviewExpired({ ...artifact, expiresAt: "2026-09-12T10:11:00Z" }, "2026-09-12T10:09:00Z"),
    ).toBe(true);
    expect(isDrainExpired("2026-09-12T10:15:00Z", "2026-09-12T10:00:00Z")).toBe(false);
    expect(isDrainExpired("2026-09-12T10:15:01Z", "2026-09-12T10:00:00Z")).toBe(true);
    expect(isDrainExpired("2026-09-12T09:59:59Z", "2026-09-12T10:00:00Z")).toBe(true);
    expect(isDrainExpired("2026-09-12T10:00:00Z", "2026-09-12T10:00:00Z")).toBe(false);
    expect(isDrainExpired("invalid", "2026-09-12T10:00:00Z")).toBe(true);
    expect(isDrainExpired("2026-09-12T10:15:00Z", "invalid")).toBe(true);
    expect(
      parseBoundedJson(new TextEncoder().encode(`null${" ".repeat(MAX_INPUT_BYTES - 4)}`)),
    ).toBeNull();
    expect(() => parseBoundedJson(new Uint8Array(MAX_INPUT_BYTES + 1))).toThrow(
      OperationsBoundaryError,
    );
    expect(() => canonicalJsonBytes(Number.NaN)).toThrow("non-finite number");
    expect(() => canonicalJsonBytes(undefined)).toThrow("unsupported JSON value");
    expect(() => canonicalJsonBytes(Symbol("unsupported"))).toThrow("unsupported JSON value");
    const nestedObject: Record<string, unknown> = {};
    let nestedCursor = nestedObject;
    for (let index = 0; index < MAX_CANONICAL_DEPTH + 1; index += 1) {
      const next: Record<string, unknown> = {};
      nestedCursor.child = next;
      nestedCursor = next;
    }
    expect(() => canonicalJsonBytes(nestedObject)).toThrow("canonical value depth limit exceeded");
    const exactDepth: Record<string, unknown> = {};
    let exactCursor = exactDepth;
    for (let index = 0; index < MAX_CANONICAL_DEPTH; index += 1) {
      const next: Record<string, unknown> = {};
      exactCursor.child = next;
      exactCursor = next;
    }
    expect(() => canonicalJsonBytes(exactDepth)).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonBytes(cyclic)).toThrow("cyclic JSON value");
  });
});
