import { existsSync } from "node:fs";

import { openSqliteDatabaseFile } from "@marea/sqlite-storage";

import { OperatorCliError } from "../operator-cli/errors.js";
import { createAccountCreationGuard } from "../operations/deletion-protection/account-creation-guard.js";
import {
  canonicalizeStorageConfiguration,
  parseStorageConfiguration,
} from "../operations/storage/configuration.js";
import { createSqliteCreationGate } from "../operations/storage/sqlite-deletion-index.js";
import { readConsistentInspection } from "../operations/storage/sqlite-deletion-index-inspection.js";
import type { IdentityCreationGuard } from "../persistence/identity-creation-guard.js";
import { readOperationsConfig, type OperationsConfig } from "./operations-config.js";

export interface DeletionAuthority {
  readonly guard: IdentityCreationGuard;
  /** Index files other executables must not overwrite with artifacts. */
  readonly reserved: readonly string[];
  close(): void;
}

function unavailable(): OperatorCliError {
  return new OperatorCliError("prerequisite-unavailable");
}

function handedOver(state: () => string): boolean {
  let current: string | undefined;
  try {
    current = state();
  } catch {
    // An unreadable index keeps refusing account creation through its gate.
  }
  return current === "transfer-prepared" || current === "retired";
}

/**
 * The creation guard of an audit-activated installation: its operations configuration must
 * name the same database and an existing deletion index, which is never created here.
 */
export function openDeletionAuthority(root: string, databasePath: string): DeletionAuthority {
  let config: OperationsConfig;
  try {
    config = readOperationsConfig(root);
  } catch {
    throw unavailable();
  }
  if (config.databasePath !== databasePath || !existsSync(config.indexPath)) throw unavailable();
  // Everything fallible is checked before the index is opened, so no failure leaks its handle.
  const configuration = canonicalizeStorageConfiguration(
    parseStorageConfiguration({
      installationRoot: root,
      databasePath: config.databasePath,
      indexPath: config.indexPath,
      authorityLineage: config.authorityLineage,
      rootId: config.rootId,
      databaseLineage: config.databaseLineage,
    }),
  );
  const file = openSqliteDatabaseFile({ databasePath: config.indexPath });
  // A quiesced or retired authority has been handed to another installation by a transfer, so
  // its database takes no further changes that the transferred copy would silently lose.
  if (handedOver(() => readConsistentInspection(file.database, configuration).state)) {
    file.close();
    throw unavailable();
  }
  return {
    guard: createAccountCreationGuard(createSqliteCreationGate(file.database, configuration)),
    reserved: [
      config.indexPath,
      `${config.indexPath}-wal`,
      `${config.indexPath}-shm`,
      `${config.indexPath}-journal`,
    ],
    close: () => {
      file.close();
    },
  };
}
