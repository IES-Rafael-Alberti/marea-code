import { rmSync } from "node:fs";
import { join } from "node:path";

import type { RecoveryBundle, RecoveryBundleInput } from "../../recovery/contracts.js";
import { createRecoveryBundle } from "../../recovery/recovery-bundle-service.js";
import type { DeletionIndex, MaintenanceCoordinator } from "../contracts.js";
import { authorityRecordPath, writeAuthorityRecord } from "./authority-record.boundary.js";

export interface AuthorizedBackupInput {
  readonly coordinator: MaintenanceCoordinator;
  readonly index: Pick<DeletionIndex, "inspect">;
  readonly drainUntil: string;
  readonly destinationPath: string;
  readonly bundle: Omit<RecoveryBundleInput, "createExclusive">;
}

/**
 * Captures a recovery bundle and the deletion authority it descends from inside one
 * exclusive maintenance run, so restores can be reconciled against later tombstones.
 */
export function createAuthorizedRecoveryBundle(
  input: AuthorizedBackupInput,
): Promise<RecoveryBundle> {
  const { sourceRoot } = input.bundle;
  return input.coordinator.run({ drainUntil: input.drainUntil }, async () => {
    writeAuthorityRecord(sourceRoot, await input.index.inspect());
    try {
      return createRecoveryBundle(input.destinationPath, {
        ...input.bundle,
        files: [...input.bundle.files, authorityRecordPath()],
        createExclusive: (operation) => operation(),
      });
    } finally {
      rmSync(join(sourceRoot, authorityRecordPath()));
    }
  });
}
