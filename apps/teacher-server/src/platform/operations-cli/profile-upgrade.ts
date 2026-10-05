import {
  createAuditMigrationCatalog,
  createEducationalMigrationCatalog,
  createProfileMigrationCatalog,
  initializeSqliteStorage,
  inspectSqliteSchemaVersion,
} from "@marea/sqlite-storage";
import type { InstallationCapability } from "../../governance/authority.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import type { OperationsConfig } from "./operations-config.js";
import { profileReleaseReadiness } from "./profile-release-readiness.js";

/** Backup publication precedes the existing transactional migration under one installation owner. */
export async function upgradeProfilesOffline(
  capability: InstallationCapability,
  config: OperationsConfig,
  backupAndClose: () => Promise<string>,
  durable?: (step: "backed-up" | "migrated") => void,
) {
  capability.assertOwned();
  if (
    ![
      createAuditMigrationCatalog().length,
      createProfileMigrationCatalog().length,
      createEducationalMigrationCatalog().length,
    ].includes(inspectSqliteSchemaVersion({ databasePath: config.databasePath }))
  )
    throw new TeacherDomainError("request.conflict");
  if (!profileReleaseReadiness(capability.installationRoot, config.releaseId).ready)
    throw new OperatorCliError("prerequisite-unavailable");
  const backupPath = await backupAndClose();
  durable?.("backed-up");
  capability.assertOwned();
  const upgraded = initializeSqliteStorage({
    databasePath: config.databasePath,
    schema: "student-identities",
  });
  try {
    durable?.("migrated");
    return { schemaVersion: upgraded.schema.version, backupPath };
  } finally {
    upgraded.close();
  }
}
