import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  createAuditMigrationCatalog,
  createProfileMigrationCatalog,
  createEducationalMigrationCatalog,
  createStudentIdentityMigrationCatalog,
  createObservabilityMigrationCatalog,
  inspectSqliteSchemaVersion,
} from "@marea/sqlite-storage";

import type { OperatorCliDependencies } from "../operator-cli/cli.js";
import type { Summary } from "../operator-cli/commands.js";
import {
  diagnosticFor,
  exitCodeFor,
  OperatorCliError,
  type ExitCode,
} from "../operator-cli/errors.js";
import { createFileHostStatus } from "../teacher-host/host-status.boundary.js";
import { readTeacherHostConfig } from "../teacher-host/teacher-host-config.js";
import { profileReleaseReadiness } from "./profile-release-readiness.js";
import { readOperationsConfig } from "./operations-config.js";

/**
 * Read-only health and upgrade preview that never takes the installation lock, so it also
 * describes an installation a running host owns. It opens nothing for writing.
 */
export async function readInstallationStatus(root: string): Promise<Summary> {
  const config = readOperationsConfig(root);

  const schemaVersion = existsSync(config.databasePath)
    ? inspectSqliteSchemaVersion({ databasePath: config.databasePath })
    : null;
  // Each activated schema is a supported running mode; anything else upgrades from schema 9.
  const supported =
    [
      createStudentIdentityMigrationCatalog().length,
      createObservabilityMigrationCatalog().length,
      createEducationalMigrationCatalog().length,
      createProfileMigrationCatalog().length,
    ].find((version) => version === schemaVersion) ?? createAuditMigrationCatalog().length;
  // Older schemas are activated forward; a newer one belongs to a later release.
  const upgrade =
    schemaVersion === null
      ? "initialize"
      : (["activate", "none", "unsupported"] as const)[Math.sign(schemaVersion - supported) + 1];
  // A broken host deployment must still expose the offline upgrade remedy.
  const hostConfig = (() => {
    try {
      return readTeacherHostConfig(root);
    } catch {
      return null;
    }
  })();
  const host =
    hostConfig === null
      ? null
      : await createFileHostStatus().read({
          installationRoot: root,
          statusPath: hostConfig.statusPath,
        });
  return {
    ...(schemaVersion === 9 ||
    schemaVersion === 10 ||
    schemaVersion === 11 ||
    schemaVersion === 12 ||
    schemaVersion === 13
      ? {
          profileUpgrade: {
            targetSchemaVersion: 13,
            state: schemaVersion === 13 ? "active" : "available-offline",
            release: profileReleaseReadiness(root, config.releaseId),
            command: "installation upgrade-profiles --input <private-json-with-new-backup-name>",
            recovery:
              "After interruption inspect status: schema 9, 10, 11 or 12 requires a new backup name and retry; schema 13 is committed. Recover abandoned ownership through the existing lock workflow.",
            rollback:
              "Stop the host. Use backup restore into an isolated destination; reconcile against the current deletion index. Switch the restored database, matching previous binaries/assets/config together under installation ownership; retain the current deletion index. Never downgrade the live database or copy an old deletion index.",
          },
        }
      : {}),
    releaseId: config.releaseId,
    schemaVersion,
    supportedSchemaVersion: supported,
    upgrade,
    locked: [join(root, ".marea-installation.lock"), join(root, "locks", "installation.lock")].some(
      (path) => existsSync(path),
    ),
    host:
      host === null
        ? null
        : { status: host.status, releaseId: host.releaseId, observedAt: host.observedAt },
  };
}

/** `--installation <root> installation status`: one JSON line, or a closed diagnostic. */
export async function runInstallationStatus(
  root: string,
  ports: Pick<OperatorCliDependencies, "stdout" | "stderr">,
): Promise<ExitCode> {
  let line: string;
  try {
    line = `${JSON.stringify(await readInstallationStatus(root))}\n`;
  } catch (error) {
    const code = exitCodeFor(
      error instanceof OperatorCliError ? error : new OperatorCliError("prerequisite-unavailable"),
    );
    await ports.stderr(diagnosticFor(code));
    return code;
  }
  await ports.stdout(line);
  return 0;
}
