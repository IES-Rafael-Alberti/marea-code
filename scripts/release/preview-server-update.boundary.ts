import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.js";
import { OperatorCliError } from "../../apps/teacher-server/src/platform/operator-cli/errors.js";
import { acquireWithLockRecovery } from "../../apps/teacher-server/src/platform/installation/abandoned-lock-recovery.js";
import { processLockRecovery } from "../../apps/teacher-server/src/platform/installation/lock-recovery-terminal.boundary.js";
import { createOperationsApplication } from "../../apps/teacher-server/src/platform/operations-cli/operations-application.js";
import { readOperationsConfig } from "../../apps/teacher-server/src/platform/operations-cli/operations-config.js";
import { readTeacherHostConfig } from "../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js";
import { installExampleSkill } from "./preview-skills.boundary.js";
import {
  currentDatabaseSchema,
  rollbackInterruptedUpdate,
  type UpdateJournal,
} from "./preview-update-recovery.boundary.js";
import { UpdateRolledBackError } from "./preview-update-rolled-back.js";

export const updateJournal = "preview-update-pending.json";

/** Review abandoned locks before downloading. Activation still takes its own exclusive lock. */
export async function assertPreviewServerIdle(installation: string): Promise<void> {
  const owner = await acquireWithLockRecovery(
    acquireInstallation,
    processLockRecovery(),
  )(installation);
  if (!owner.release()) throw new OperatorCliError("installation-lost");
}

/**
 * One installation owner covers backup, config and activation. A failure after the journal is
 * written returns to the previous release when the database was not changed; otherwise the
 * journal stays and launches fail closed until the backup is restored.
 */
export async function activatePreviewServer<T>(
  installation: string,
  destination: string,
  version: string,
  activate: () => Promise<T>,
): Promise<T> {
  const owner = acquireInstallation(installation);
  try {
    const journal = join(installation, "state", updateJournal);
    if (existsSync(journal))
      throw new Error("Previous update needs recovery; inspect state/preview-update-pending.json");
    const config = readOperationsConfig(installation);
    const host = readTeacherHostConfig(installation);
    const application = createOperationsApplication(owner.capability, config, () =>
      new Date().toISOString(),
    );
    let backup: string;
    try {
      backup = (await application.createBackup(`preview-${randomUUID()}`)).path;
    } finally {
      application.close();
    }
    const record: UpdateJournal = {
      format: 2,
      version,
      destination,
      backup,
      previousHost: { ...host },
      schemaVersion: currentDatabaseSchema(installation),
      previousActive: readIfPresent(join(dirname(destination), "active.json")),
      destinationExisted: existsSync(destination),
    };
    writeFileSync(journal, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    try {
      owner.capability.assertOwned();
      return await switchRelease(
        owner.capability,
        installation,
        host,
        destination,
        version,
        activate,
      );
    } catch (error) {
      // The new binary migrates at startup, so a database still at the recorded schema is untouched.
      if (rollbackInterruptedUpdate(installation, journal))
        throw new UpdateRolledBackError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  } finally {
    owner.release();
  }
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

async function switchRelease<T>(
  capability: { readonly assertOwned: () => void },
  installation: string,
  host: ReturnType<typeof readTeacherHostConfig>,
  destination: string,
  version: string,
  activate: () => Promise<T>,
): Promise<T> {
  const result = await activate();
  installExampleSkill(installation, destination);
  const hostPath = join(installation, "config", "teacher-host.json");
  const next = `${hostPath}.${randomUUID()}.tmp`;
  writeFileSync(
    next,
    JSON.stringify(
      { ...host, dashboardDistPath: join(destination, "dashboard"), serverVersion: version },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  renameSync(next, hostPath);
  capability.assertOwned();
  // Parse and validate the newly selected files before declaring the transaction finished.
  readTeacherHostConfig(installation);
  rmSync(join(installation, "state", updateJournal));
  return result;
}

/**
 * Called at launch when a journal remains: the process died mid-update. Takes the installation
 * lock and returns to the previous release if the database is unchanged; returns false when it
 * must be restored by hand. Does nothing and returns undefined without a journal.
 */
export function recoverInterruptedPreviewUpdate(installation: string): boolean | undefined {
  const journal = join(installation, "state", updateJournal);
  if (!existsSync(journal)) return undefined;
  const owner = acquireInstallation(installation);
  try {
    return rollbackInterruptedUpdate(installation, journal);
  } finally {
    owner.release();
  }
}

export function assertPreviewServerReady(installation: string): string {
  if (existsSync(join(installation, "state", updateJournal)))
    throw new Error(
      "An interrupted update needs recovery. Keep the backup; do not start an older binary against migrated data.",
    );
  // Read through the existing private configuration validator, not an arbitrary launcher argument.
  const host = readTeacherHostConfig(installation);
  if (readFileSync(join(host.dashboardDistPath, "index.html")).length === 0)
    throw new Error("Dashboard is missing");
  return host.releaseId;
}
