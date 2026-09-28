import {
  activateRetentionAuditSchema,
  createSqliteAuditStore,
  type AuditDisposition,
  type AuditDispositionInput,
  type AuditOperationRecord,
  type AuditOperationState,
  type SqliteApplicationDatabase,
} from "@marea/sqlite-storage";

import {
  canonicalJsonBytes,
  encodeArtifact,
  targetIdentity,
  observationMatches,
  PreviewArtifactSchema,
  type PreviewArtifact,
  type TargetRef,
} from "../index.js";

export interface AuditStore {
  recordPrepared(artifact: PreviewArtifact, now: string): void;
  advance(input: AuditAdvanceIntent): void;
  read(operationId: string): AuditOperationRecord | undefined;
}

export interface AuditAdvanceIntent {
  readonly operationId: string;
  readonly expectedState: AuditOperationState;
  readonly nextState: AuditOperationState;
  readonly now: string;
  readonly errorCode?: string | null;
}

export interface ContentDisposition {
  readonly target: TargetRef;
  readonly disposition: AuditDisposition;
  readonly detailCode?: string | null;
  readonly updatedAt: string;
}

export interface ContentDispositionStore {
  record(operationId: string, disposition: ContentDisposition): void;
  list(operationId: string): readonly AuditDispositionInput[];
}

export interface AuditIndexEvidence {
  read(input: AuditIndexEvidenceRequest): AuditIndexEvidenceResult;
}

export interface AuditIndexEvidenceRequest {
  readonly operationId: string;
  readonly authorityLineage: string;
  readonly artifactDigest: string;
  readonly expectedIndexGeneration: number;
}

export type AuditIndexEvidenceResult =
  | {
      readonly kind: "no-intent";
      readonly operationId: string;
      readonly authorityLineage: string;
      readonly artifactDigest: string;
      readonly expectedIndexGeneration: number;
    }
  | {
      readonly kind: "intent";
      readonly operationId: string;
      readonly authorityLineage: string;
      readonly artifactDigest: string;
      readonly expectedIndexGeneration: number;
      readonly nextIndexGeneration: number;
      readonly state: "committed" | "uncertain";
      readonly contentState: "pending" | "in-progress" | "complete";
      readonly durableIntent: "committed";
    }
  | { readonly kind: "unavailable" };

function assertNoIntent(current: AuditOperationRecord, fact: AuditIndexEvidenceResult): void {
  if (
    fact.kind !== "no-intent" ||
    fact.operationId !== current.operationId ||
    fact.authorityLineage !== current.authorityLineage ||
    fact.artifactDigest !== current.artifactDigest ||
    fact.expectedIndexGeneration !== current.expectedIndexGeneration
  )
    throw new Error("Pre-intent failure requires verified no-intent evidence.");
}

function assertIntent(
  current: AuditOperationRecord,
  nextState: AuditOperationState,
  fact: AuditIndexEvidenceResult,
): void {
  if (fact.kind !== "intent")
    throw new Error("State completion requires verified durable index intent.");
  if (
    fact.operationId !== current.operationId ||
    fact.authorityLineage !== current.authorityLineage ||
    fact.artifactDigest !== current.artifactDigest ||
    fact.expectedIndexGeneration !== current.expectedIndexGeneration ||
    fact.nextIndexGeneration !== current.expectedIndexGeneration + 1
  )
    throw new Error("State completion requires matching durable index intent.");
  if (current.state !== "uncertain" && fact.state !== "committed")
    throw new Error("Uncertain index evidence cannot authorize a normal transition.");
  const requiredContentState =
    nextState === "index-committed"
      ? "pending"
      : nextState === "content-started"
        ? "in-progress"
        : "complete";
  if (fact.contentState !== requiredContentState)
    throw new Error("Audit content state is not durably complete.");
}

function json(value: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytes(value));
}

export function activateApplicationAuditSchema(database: SqliteApplicationDatabase): void {
  activateRetentionAuditSchema(database);
}

export function createApplicationAuditStores(
  database: SqliteApplicationDatabase,
  evidence: AuditIndexEvidence,
): {
  readonly audit: AuditStore;
  readonly dispositions: ContentDispositionStore;
} {
  const store = createSqliteAuditStore(database);
  const audit = Object.freeze<AuditStore>({
    recordPrepared(artifact, now): void {
      const encoded = encodeArtifact(artifact);
      const operation = {
        operationId: artifact.previewId,
        requestId: artifact.requestId,
        authorityLineage: artifact.authorityLineage,
        actorBinding: artifact.actorBinding,
        policyRevision: artifact.policyRevision,
        artifactDigest: artifact.artifactDigest,
        graphDigest: artifact.graphDigest,
        expectedIndexGeneration: artifact.expectedIndexGeneration,
        artifactJson: new TextDecoder().decode(encoded),
        state: "prepared" as const,
        createdAt: artifact.createdAt,
        updatedAt: now,
        errorCode: null,
      };
      store.appendPrepared(
        operation,
        artifact.targets.map((target) => ({
          operationId: artifact.previewId,
          targetKind: target.kind,
          logicalKey: targetIdentity(target),
          observedJson: json(target.observed),
          disposition: "planned" as const,
          detailCode: null,
          updatedAt: now,
        })),
      );
    },
    advance(input): void {
      const current = store.readOperation(input.operationId);
      if (current === undefined) throw new Error("Audit operation does not exist.");
      if (current.state !== input.expectedState)
        throw new Error("Audit operation expected state does not match.");
      const fact = evidence.read({
        operationId: current.operationId,
        authorityLineage: current.authorityLineage,
        artifactDigest: current.artifactDigest,
        expectedIndexGeneration: current.expectedIndexGeneration,
      });
      if (input.nextState === "failed") assertNoIntent(current, fact);
      if (input.nextState !== "failed" && input.nextState !== "uncertain")
        assertIntent(current, input.nextState, fact);
      store.updateState(input.operationId, input.nextState, input.now, input.errorCode ?? null);
    },
    read(operationId): AuditOperationRecord | undefined {
      return store.readOperation(operationId);
    },
  });
  const dispositions = Object.freeze<ContentDispositionStore>({
    record(operationId, value): void {
      const operation = store.readOperation(operationId);
      if (operation === undefined) throw new Error("Audit operation does not exist.");
      let artifact: PreviewArtifact;
      try {
        artifact = PreviewArtifactSchema.parse(JSON.parse(operation.artifactJson) as unknown);
      } catch {
        throw new Error("Audit artifact is malformed.");
      }
      const target = artifact.targets.find(
        (candidate) => targetIdentity(candidate) === targetIdentity(value.target),
      );
      if (target === undefined) throw new Error("Content disposition target is not planned.");
      if (!observationMatches(target, value.target))
        throw new Error("Content disposition does not match planned observation.");
      store.updateDisposition({
        operationId,
        targetKind: value.target.kind,
        logicalKey: targetIdentity(value.target),
        observedJson: json(value.target.observed),
        disposition: value.disposition,
        detailCode: value.detailCode ?? null,
        updatedAt: value.updatedAt,
      });
    },
    list(operationId) {
      return store.readDispositions(operationId);
    },
  });
  return Object.freeze({ audit, dispositions });
}
