import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import type { IndexInspection } from "../schemas.js";
import { canonicalizeStorageConfiguration, type StorageConfiguration } from "./configuration.js";
import { DeletionIndexStorageError } from "./deletion-index-errors.js";
import { readConsistentInspection } from "./sqlite-deletion-index-inspection.js";

type AuthorityState = IndexInspection["state"];

function stale(): DeletionIndexStorageError {
  return new DeletionIndexStorageError(
    "stale-authority",
    "Deletion authority is not transferable.",
  );
}

/**
 * Moves one index between transfer states inside a transaction. The index must be consistent, at
 * the expected generation, without a pending deletion and in one of the allowed states; reaching
 * the target state again is idempotent.
 */
export function transitionTransferAuthority(
  database: SqliteApplicationDatabase,
  configuration: StorageConfiguration,
  transition: {
    readonly from: readonly AuthorityState[];
    readonly to: AuthorityState;
    readonly generation: number;
  },
): IndexInspection {
  const expected = canonicalizeStorageConfiguration(configuration);
  return database.transaction(() => {
    const current = readConsistentInspection(database, expected);
    if (
      current.generation !== transition.generation ||
      current.pendingCheckpoint !== null ||
      (current.state !== transition.to && !transition.from.includes(current.state))
    )
      throw stale();
    database.execute("UPDATE marea_deletion_index_meta SET state = ?1 WHERE singleton = 1", [
      transition.to,
    ]);
    return readConsistentInspection(database, expected);
  });
}

/**
 * Rebinds a byte copy of a quiesced source index to the destination root. The copy keeps every
 * tombstone and checkpoint and stays inactive until the destination is activated.
 */
export function adoptTransferredIndex(
  database: SqliteApplicationDatabase,
  source: StorageConfiguration,
  destination: StorageConfiguration,
  generation: number,
): IndexInspection {
  const from = canonicalizeStorageConfiguration(source);
  const to = canonicalizeStorageConfiguration(destination);
  if (
    from.authorityLineage !== to.authorityLineage ||
    from.databaseLineage !== to.databaseLineage ||
    from.rootId === to.rootId
  )
    throw stale();
  return database.transaction(() => {
    const copied = readConsistentInspection(database, from);
    if (
      copied.state !== "transfer-prepared" ||
      copied.generation !== generation ||
      copied.pendingCheckpoint !== null
    )
      throw stale();
    database.execute("UPDATE marea_deletion_index_meta SET root_id = ?1 WHERE singleton = 1", [
      to.rootId,
    ]);
    return readConsistentInspection(database, to);
  });
}
