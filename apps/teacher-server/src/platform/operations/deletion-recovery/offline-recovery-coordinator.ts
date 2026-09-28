import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import {
  HostOperationError,
  type HostConfigurationPort,
  type HostStoragePort,
  type InstallationExclusivity,
} from "../host/contracts.js";

/** Exclusive writable access for recovery while no host serves the installation. */
export interface RecoveryCoordinator {
  exclusive<T>(operation: (database: SqliteApplicationDatabase) => Promise<T>): Promise<T>;
}

export interface OfflineRecoveryDependencies {
  readonly installationRoot: string;
  readonly exclusivity: InstallationExclusivity;
  readonly configuration: HostConfigurationPort;
  readonly storage: HostStoragePort;
}

/**
 * Takes the installation lock shared with the host, so a live host makes recovery fail
 * with the lock error. Unlike maintenance it does not require a ready deletion index:
 * recovery exists to resolve pending or uncertain checkpoints.
 */
export function createOfflineRecoveryCoordinator(
  dependencies: OfflineRecoveryDependencies,
): RecoveryCoordinator {
  return Object.freeze({
    async exclusive<T>(operation: (database: SqliteApplicationDatabase) => Promise<T>) {
      const lock = await dependencies.exclusivity.acquire(dependencies.installationRoot);
      try {
        const installationRoot = lock.canonicalRoot;
        const config = await dependencies.configuration.read({ installationRoot });
        await dependencies.configuration.validate({
          installationRoot,
          config,
          requestedReleaseId: config.releaseId,
        });
        const handle = await dependencies.storage.open({
          installationRoot,
          config,
          mode: "read-write",
        });
        try {
          if (handle.mode !== "read-write")
            throw new HostOperationError("not-ready", "recovery requires a writable database");
          return await operation(handle.database as SqliteApplicationDatabase);
        } finally {
          await handle.close();
        }
      } finally {
        await lock.release();
      }
    },
  });
}
