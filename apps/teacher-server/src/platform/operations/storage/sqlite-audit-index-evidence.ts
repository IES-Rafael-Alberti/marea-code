import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type {
  AuditIndexEvidence,
  AuditIndexEvidenceRequest,
  AuditIndexEvidenceResult,
} from "./application-audit-store.js";

import { readCheckpoint, readConsistentInspection } from "./sqlite-deletion-index-inspection.js";
import { canonicalizeStorageConfiguration, type StorageConfiguration } from "./configuration.js";

export type SqliteAuditIndexEvidenceRequest = AuditIndexEvidenceRequest;
export type SqliteAuditIndexEvidenceResult = AuditIndexEvidenceResult;
export type SqliteAuditIndexEvidence = AuditIndexEvidence;

/** Read-only evidence bridge used to authorize application audit transitions. */
export function createSqliteAuditIndexEvidence(
  database: SqliteApplicationDatabase,
  configuration: StorageConfiguration,
): SqliteAuditIndexEvidence {
  const expected = canonicalizeStorageConfiguration(configuration);
  return Object.freeze({
    read(input: SqliteAuditIndexEvidenceRequest): SqliteAuditIndexEvidenceResult {
      try {
        const inspection = readConsistentInspection(database, expected);
        if (inspection.state !== "active") return { kind: "unavailable" };
        const checkpoint = readCheckpoint(database, input.operationId)?.checkpoint;
        if (checkpoint === undefined) {
          if (
            inspection.pendingCheckpoint !== null ||
            inspection.generation !== input.expectedIndexGeneration
          )
            return { kind: "unavailable" };
          return {
            kind: "no-intent",
            operationId: input.operationId,
            authorityLineage: input.authorityLineage,
            artifactDigest: input.artifactDigest,
            expectedIndexGeneration: input.expectedIndexGeneration,
          };
        }
        if (
          checkpoint.authorityLineage !== input.authorityLineage ||
          checkpoint.expectedIndexGeneration !== input.expectedIndexGeneration ||
          checkpoint.artifactDigest !== input.artifactDigest
        )
          return { kind: "unavailable" };
        if (checkpoint.durableIntent !== "committed") {
          if (inspection.generation !== checkpoint.expectedIndexGeneration)
            return { kind: "unavailable" };
          return {
            kind: "no-intent",
            operationId: checkpoint.operationId,
            authorityLineage: checkpoint.authorityLineage,
            artifactDigest: checkpoint.artifactDigest,
            expectedIndexGeneration: checkpoint.expectedIndexGeneration,
          };
        }
        if (inspection.generation !== checkpoint.nextIndexGeneration)
          return { kind: "unavailable" };
        return {
          kind: "intent",
          operationId: checkpoint.operationId,
          authorityLineage: checkpoint.authorityLineage,
          artifactDigest: checkpoint.artifactDigest,
          expectedIndexGeneration: checkpoint.expectedIndexGeneration,
          nextIndexGeneration: checkpoint.nextIndexGeneration,
          state: checkpoint.state === "uncertain" ? "uncertain" : "committed",
          contentState: checkpoint.contentState,
          durableIntent: "committed",
        };
      } catch {
        return { kind: "unavailable" };
      }
    },
  });
}
