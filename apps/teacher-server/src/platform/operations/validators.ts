import {
  CreationGateResultSchema,
  IndexInspectionSchema,
  IndexCheckpointSchema,
  TargetRefSchema,
  type CreationGateResult,
  type IndexInspection,
  type TargetRef,
} from "./schemas.js";
import { RecoveryInputSchema, type RecoveryInput } from "./recovery-schemas.js";
import {
  OperationsBoundaryError,
  bytesEqual,
  canonicalJsonBytes,
  parseBoundedJson,
} from "./canonical-encoder.js";

export function parseTarget(value: unknown): TargetRef {
  try {
    return TargetRefSchema.parse(value);
  } catch {
    throw new OperationsBoundaryError("invalid-input", "target payload is invalid");
  }
}

export function parseRecoveryInput(bytes: Uint8Array): RecoveryInput {
  try {
    const value = parseBoundedJson(bytes);
    return RecoveryInputSchema.parse(value);
  } catch (error) {
    if (error instanceof OperationsBoundaryError) throw error;
    throw new OperationsBoundaryError("invalid-input", "recovery input is invalid");
  }
}

export function parseCreationGateResult(value: unknown): CreationGateResult {
  try {
    return CreationGateResultSchema.parse(value);
  } catch {
    throw new OperationsBoundaryError("invalid-input", "creation result is invalid");
  }
}

export function targetLogicalKey(target: TargetRef): Record<string, string> {
  switch (target.kind) {
    case "account":
      return { userId: target.key.userId };
    case "center":
      return { centerId: target.key.centerId };
    case "class":
      return { classId: target.key.classId };
    case "center-membership":
      return { centerId: target.key.centerId, userId: target.key.userId };
    case "class-membership":
      return { classId: target.key.classId, userId: target.key.userId };
    case "teaching-revision":
      return { revisionId: target.key.revisionId };
    case "run":
      return { runId: target.key.runId };
    case "snapshot":
      return { snapshotId: target.key.snapshotId };
    case "skill":
      return { skillId: target.key.skillId };
    case "backup":
      return { manifestDigest: target.key.manifestDigest };
  }
}

export function targetIdentity(target: TargetRef): string {
  return new TextDecoder().decode(
    canonicalJsonBytes({ kind: target.kind, key: targetLogicalKey(target) }),
  );
}

export function targetMatches(left: TargetRef, right: TargetRef): boolean {
  return targetIdentity(left) === targetIdentity(right);
}

export function observationMatches(left: TargetRef, right: TargetRef): boolean {
  return (
    targetMatches(left, right) &&
    bytesEqual(canonicalJsonBytes(left.observed), canonicalJsonBytes(right.observed))
  );
}

export function assertCreatable(
  target: TargetRef,
  authority: IndexInspection | null,
  tombstoneKeys: readonly string[],
  pendingCheckpoint?: boolean | import("./schemas.js").IndexCheckpoint | null,
): CreationGateResult {
  if (authority === null) return { allowed: false, code: "missing-authority" };
  const parsed = IndexInspectionSchema.parse(authority);
  if (parsed.state !== "active")
    return { allowed: false, code: parsed.state === "corrupt" ? "corrupt" : "uncertain" };
  if (parsed.pendingCheckpoint !== null || pendingCheckpoint === true)
    return { allowed: false, code: "uncertain" };
  const key = `${parsed.authorityLineage}:${targetIdentity(target)}`;
  if (pendingCheckpoint === false || pendingCheckpoint === null || pendingCheckpoint === undefined)
    return tombstoneKeys.includes(key) ? { allowed: false, code: "tombstoned" } : { allowed: true };
  IndexCheckpointSchema.parse(pendingCheckpoint);
  return { allowed: false, code: "uncertain" };
}

export function assertCanonicalJson(value: unknown, maximumBytes: number): void {
  canonicalJsonBytes(value, maximumBytes);
}
