import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initializeSqliteStorage } from "@marea/sqlite-storage";
import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.js";
import { createOperationsApplication } from "../../apps/teacher-server/src/platform/operations-cli/operations-application.js";
import { readOperationsConfig } from "../../apps/teacher-server/src/platform/operations-cli/operations-config.js";
import { readTeacherHostConfig } from "../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js";
import { installExampleSkill } from "./preview-skills.boundary.js";

export const updateJournal = "preview-update-pending.json";

/** One installation owner covers backup, migration, config and activation; interrupted updates fail closed. */
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
    writeFileSync(
      journal,
      JSON.stringify({ format: 1, version, destination, backup, previousHost: host }),
      { flag: "wx", mode: 0o600 },
    );
    owner.capability.assertOwned();
    initializeSqliteStorage({
      databasePath: config.databasePath,
      schema: "student-identities",
    }).close();
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
    owner.capability.assertOwned();
    // Parse and validate the newly selected files before declaring the transaction finished.
    readTeacherHostConfig(installation);
    rmSync(journal);
    return result;
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
