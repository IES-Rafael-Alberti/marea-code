import {
  AuthorityCheckpointSchema,
  IndexInspectionSchema,
  RestoredDatabaseIdentitySchema,
  type IndexInspection,
  type Reconciliation,
  type RestoredDatabaseIdentity,
  type TargetRef,
} from "./schemas.js";
import { targetIdentity } from "./validators.js";
import { authorityCheckpointDigest } from "./authority.js";

export function reconcileRestoredTargets(
  identity: RestoredDatabaseIdentity,
  authority: IndexInspection | null,
  restoredTargets: readonly TargetRef[],
  tombstoneKeys: readonly string[],
): Reconciliation {
  const source = RestoredDatabaseIdentitySchema.parse(identity);
  if (authority === null) {
    return {
      state: "blocked",
      currentIndexGeneration: 0,
      checked: 0,
      tombstoned: [],
      reasonCode: "missing-authority",
    };
  }
  const current = IndexInspectionSchema.parse(authority);
  if (current.state !== "active" || current.pendingCheckpoint !== null) {
    return {
      state: "blocked",
      currentIndexGeneration: current.generation,
      checked: 0,
      tombstoned: [],
      reasonCode: current.pendingCheckpoint === null ? "missing-authority" : "pending-checkpoint",
    };
  }
  const sourceGeneration = source.sourceIndexGeneration;
  if (
    sourceGeneration === null ||
    source.sourceAuthorityLineage !== current.authorityLineage ||
    source.destinationAuthorityLineage !== current.authorityLineage ||
    source.destinationRootId !== current.rootId ||
    source.sourceDatabaseLineage !== current.databaseLineage
  ) {
    return {
      state: "blocked",
      currentIndexGeneration: current.generation,
      checked: 0,
      tombstoned: [],
      reasonCode:
        source.sourceAuthorityLineage !== current.authorityLineage ||
        source.destinationAuthorityLineage !== current.authorityLineage
          ? "lineage-conflict"
          : "unknown-ancestry",
    };
  }
  const sourceCheckpoint = AuthorityCheckpointSchema.parse({
    authorityLineage: source.sourceAuthorityLineage,
    rootId: source.rootId,
    indexGeneration: sourceGeneration,
    databaseLineage: source.sourceDatabaseLineage,
    bundleManifestDigest: source.sourceBundleManifestDigest,
  });
  if (authorityCheckpointDigest(sourceCheckpoint) !== source.sourceCheckpointDigest) {
    return {
      state: "blocked",
      currentIndexGeneration: current.generation,
      checked: 0,
      tombstoned: [],
      reasonCode: "unknown-ancestry",
    };
  }
  if (sourceGeneration > current.generation) {
    return {
      state: "blocked",
      currentIndexGeneration: current.generation,
      checked: 0,
      tombstoned: [],
      reasonCode: "stale-generation",
    };
  }
  const tombstoned = restoredTargets.filter((target) =>
    tombstoneKeys.includes(`${current.authorityLineage}:${targetIdentity(target)}`),
  );
  if (tombstoned.length > 0) {
    return {
      state: "blocked",
      currentIndexGeneration: current.generation,
      checked: restoredTargets.length,
      tombstoned,
      reasonCode: "tombstoned-identity",
    };
  }
  return {
    state: "verified",
    currentIndexGeneration: current.generation,
    checked: restoredTargets.length,
    tombstoned: [],
    reasonCode: "none",
  };
}
