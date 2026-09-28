import type { RecoveryBundleLimits } from "../../recovery/contracts.js";
import { authorityCheckpointDigest } from "../authority.js";
import type { DeletionIndex, ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import { readVerifiedBundle } from "../retention/retention-backups.boundary.js";
import {
  ReconciliationSchema,
  RestoredDatabaseIdentitySchema,
  type Reconciliation,
} from "../schemas.js";
import type { RestoredTargetReader } from "../storage/sqlite-deletion-index.js";
import { readAuthorityRecord } from "./authority-record.boundary.js";
import { readRestoredTargets } from "./restored-targets.js";

export interface RestoreReconciliationInput {
  /** The verified bundle the isolated database was restored from. */
  readonly bundlePath: string;
  readonly limits: RecoveryBundleLimits;
  /** The database restored into an isolated root that no host serves yet. */
  readonly restored: ReadOnlySqliteApplicationDatabase;
  readonly destination: { readonly authorityLineage: string; readonly rootId: string };
  /** The current installation index, bound to a reader of the restored identities. */
  readonly indexFor: (reader: RestoredTargetReader) => DeletionIndex;
}

/**
 * Proves that an isolated restore descends from this installation's deletion authority
 * and resurrects no tombstoned identity. Anything else is blocked for operator review.
 */
export async function reconcileRestoredBundle(
  input: RestoreReconciliationInput,
): Promise<Reconciliation> {
  const bundle = readVerifiedBundle(input.bundlePath, input.limits);
  const record = readAuthorityRecord(input.bundlePath, bundle.manifest);
  const index = input.indexFor({
    read: () => Promise.resolve(readRestoredTargets(input.restored, bundle.target)),
  });
  if (record === undefined)
    return ReconciliationSchema.parse({
      state: "blocked",
      currentIndexGeneration: (await index.inspect()).generation,
      checked: 0,
      tombstoned: [],
      reasonCode: "unknown-ancestry",
    });
  const bundleManifestDigest = bundle.target.key.manifestDigest;
  return index.reconcile(
    RestoredDatabaseIdentitySchema.parse({
      rootId: record.rootId,
      sourceAuthorityLineage: record.authorityLineage,
      sourceDatabaseLineage: record.databaseLineage,
      sourceBundleManifestDigest: bundleManifestDigest,
      sourceIndexGeneration: record.indexGeneration,
      sourceCheckpointDigest: authorityCheckpointDigest({
        authorityLineage: record.authorityLineage,
        rootId: record.rootId,
        indexGeneration: record.indexGeneration,
        databaseLineage: record.databaseLineage,
        bundleManifestDigest,
      }),
      destinationAuthorityLineage: input.destination.authorityLineage,
      destinationRootId: input.destination.rootId,
    }),
  );
}
