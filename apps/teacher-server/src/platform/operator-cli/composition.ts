import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  MAX_GOVERNANCE_REQUEST_BYTES,
  MAX_TEACHING_CONFIGURATION_BYTES,
  RevisionIdSchema,
} from "@marea/protocol";
import {
  createAuditMigrationCatalog,
  createProfileMigrationCatalog,
  createEducationalMigrationCatalog,
  createStudentIdentityMigrationCatalog,
  initializeSqliteStorage,
  inspectSqliteSchemaVersion,
  type SqliteStorage,
} from "@marea/sqlite-storage";
import { createMigrationCatalog } from "@marea/sqlite-storage/migrations";
import type { InstallationCapability } from "../../governance/authority.js";
import { createGovernanceOperatorApplication } from "../../governance/operator-application.boundary.js";
import { bunArgon2idPasswordHasher } from "../../identity/password-hasher.boundary.js";
import { GovernanceSourceCoordinator } from "../persistence/governance-source-coordinator.js";
import { openDeletionAuthority } from "../operations-cli/deletion-authority.js";
import { withoutDeletionAuthority } from "../persistence/identity-creation-guard.js";
import { createSqliteGovernanceRepository } from "../persistence/sqlite-governance-repository.js";
import { SqliteTeachingConfigurationRepository } from "../persistence/sqlite-teaching-configuration-repository.js";
import { createGovernanceOperatorResources } from "../operator/governance-operator-resources.boundary.js";
import {
  loadOperatorConfiguration,
  readBoundedBytes,
} from "../operator/operator-filesystem-loader.js";
import { SkillAuthoringStore } from "../../teaching/authoring/skill-authoring-store.boundary.js";
import { BundledSkillSource } from "../../teaching/skills/bundled-skill-source.boundary.js";
import type { ComposedInstallation } from "./cli.js";
import { OperatorCliError } from "./errors.js";
import { currentUid, overlapsInstallationPaths, privateDescendantKind } from "./private-path.js";

const Owner = z.object({ id: z.string(), root: z.string() }).strict();
const ConfigSchema = z
  .object({
    version: z.literal(1),
    databasePath: z.string(),
    operatorPolicyPath: z.string(),
    coreSourcePath: z.string(),
    centers: z.array(Owner),
    teachers: z.array(Owner),
    personalOwners: z.array(
      z.object({ classId: RevisionIdSchema, teacherId: z.string() }).strict(),
    ),
  })
  .strict();
/** GOVERNANCE CLI installation contract `<root>/config/operator-cli.json`, proposed for OPERATIONS review. */
export type OperatorCliConfig = z.infer<typeof ConfigSchema>;

function unavailable(): OperatorCliError {
  return new OperatorCliError("prerequisite-unavailable");
}

/**
 * Explicit, minimal and closed: canonical private files/directories strictly inside the
 * installation, pairwise non-overlapping and outside `locks`/`config`, unique owner IDs, and
 * one configured teacher per personal-owner class. Nothing is created, scanned or defaulted.
 */
export function readOperatorCliConfig(root: string, uid = currentUid()): OperatorCliConfig {
  const configPath = join(root, "config", "operator-cli.json");
  if (privateDescendantKind(root, configPath, uid) !== "file") throw unavailable();
  const config = ConfigSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        readBoundedBytes(configPath, MAX_GOVERNANCE_REQUEST_BYTES),
      ),
    ),
  );
  const directories = [
    config.coreSourcePath,
    ...[...config.centers, ...config.teachers].map((owner) => owner.root),
  ];
  const files = [config.databasePath, config.operatorPolicyPath];
  const paths = [...files, ...directories];
  const teachers = new Set(config.teachers.map((owner) => owner.id));
  const ids = [...config.centers, ...config.teachers].map((owner) => owner.id);
  const classes = config.personalOwners.map((entry) => entry.classId);
  if (
    files.some((path) => privateDescendantKind(root, path, uid) !== "file") ||
    directories.some((path) => privateDescendantKind(root, path, uid) !== "directory") ||
    overlapsInstallationPaths(root, paths) ||
    new Set(ids).size !== ids.length ||
    new Set(classes).size !== classes.length ||
    config.personalOwners.some((entry) => !teachers.has(entry.teacherId))
  )
    throw unavailable();
  return config;
}

/** Composes the accepted private ports only after exclusive ownership; state is never created or upgraded. */
/** The operator-assigned personal library owner of each class. */
export function personalOwnerForClass(config: OperatorCliConfig): ReadonlyMap<string, string> {
  return new Map(config.personalOwners.map((entry) => [entry.classId, entry.teacherId]));
}

export function createOperatorCliApplication(
  capability: InstallationCapability,
  config: OperatorCliConfig,
): ComposedInstallation {
  capability.assertOwned();
  const version = inspectSqliteSchemaVersion({ databasePath: config.databasePath });
  const identities = version === createStudentIdentityMigrationCatalog().length;
  const educational = identities || version === createEducationalMigrationCatalog().length;
  const profiles = educational || version === createProfileMigrationCatalog().length;
  const activated = version === createAuditMigrationCatalog().length || profiles;
  if (!activated && version !== createMigrationCatalog().length) throw unavailable();
  // After OPERATIONS activation, account creation consults the deletion index of this installation.
  const authority = activated
    ? openDeletionAuthority(capability.installationRoot, config.databasePath)
    : { guard: withoutDeletionAuthority(), reserved: [], close: () => undefined };
  let storage: SqliteStorage;
  try {
    storage = initializeSqliteStorage(
      activated
        ? {
            databasePath: config.databasePath,
            schema: identities
              ? "student-identities"
              : educational
                ? "educational-insights"
                : profiles
                  ? "dashboard-profiles"
                  : "retention-audit",
          }
        : { databasePath: config.databasePath },
    );
  } catch (error) {
    authority.close();
    throw error;
  }
  try {
    const store = (source: "center" | "teacher") => (owner: { id: string; root: string }) =>
      [owner.id, new SkillAuthoringStore(owner.root, { source, id: owner.id })] as const;
    const centers = new Map(config.centers.map(store("center")));
    const teachers = new Map(config.teachers.map(store("teacher")));
    const core = new BundledSkillSource(config.coreSourcePath);
    const policy = loadOperatorConfiguration(
      config.operatorPolicyPath,
      MAX_TEACHING_CONFIGURATION_BYTES,
    );
    const clock = { now: () => new Date().toISOString() };
    const repository = createSqliteGovernanceRepository(
      storage.database,
      (classId) => policy.forClass(classId) !== null,
      authority.guard,
    );
    const application = createGovernanceOperatorApplication(
      {
        repository,
        clock,
        operator: policy,
        passwords: bunArgon2idPasswordHasher,
        secrets: { issue: () => randomUUID() },
        ids: { createId: (kind) => RevisionIdSchema.parse(`${kind}:cli:${randomUUID()}`) },
        sources: new GovernanceSourceCoordinator({
          core,
          centers,
          teachers,
          operatorPersonalOwnerForClass: personalOwnerForClass(config),
          repository,
          membership: new SqliteTeachingConfigurationRepository(storage.database),
          clock,
        }),
      },
      createGovernanceOperatorResources({ core, centers, teachers }),
    );
    return {
      application,
      reserved: [
        join(capability.installationRoot, "locks"),
        join(capability.installationRoot, "config"),
        config.databasePath,
        `${config.databasePath}-wal`,
        `${config.databasePath}-shm`,
        `${config.databasePath}-journal`,
        config.operatorPolicyPath,
        ...config.centers.map((owner) => owner.root),
        ...config.teachers.map((owner) => owner.root),
        config.coreSourcePath,
        ...authority.reserved,
      ],
      close: () => {
        storage.close();
        authority.close();
      },
    };
  } catch (error) {
    storage.close();
    authority.close();
    throw error;
  }
}

/** Configuration, schema and port failures are a missing prerequisite unless ownership was lost. */
export function composeInstallation(capability: InstallationCapability): ComposedInstallation {
  try {
    return createOperatorCliApplication(
      capability,
      readOperatorCliConfig(capability.installationRoot),
    );
  } catch (error) {
    if (error instanceof OperatorCliError) throw error;
    throw unavailable();
  }
}
