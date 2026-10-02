import {
  commitServerSettings,
  prepareServerSettings,
} from "../teacher-host/initialize-server-settings.js";
import type {
  ContinueInput,
  OperationsApplication,
  PreviewInput,
  MarkFailedInput,
  ReconcileInput,
  RestoreInput,
  RestoreResult,
} from "./operations-application-contracts.js";
export type { OperationsApplication } from "./operations-application-contracts.js";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createAuditMigrationCatalog,
  createProfileMigrationCatalog,
  createEducationalMigrationCatalog,
  createMigrationCatalog,
  initializeSqliteStorage,
  inspectSqliteSchemaVersion,
  openSqliteDatabaseFile,
  type SqliteApplicationDatabase,
  type SqliteDatabaseFile,
  type SqliteStorage,
} from "@marea/sqlite-storage";

import type { InstallationCapability } from "../../governance/authority.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import { currentUid, isInside, privateKind } from "../operator-cli/private-path.js";
import {
  createRecoveryBundle,
  restoreRecoveryBundle,
} from "../recovery/recovery-bundle-service.js";
import { PREVIEW_LIFETIME_MS } from "../operations/canonical-encoder.js";
import type { MaintenanceCoordinator } from "../operations/contracts.js";
import { createDeletionRecoveryService } from "../operations/deletion-recovery/deletion-recovery.js";
import { createAuthorizedRecoveryBundle } from "../operations/restore-authority/authorized-backup.js";
import { reconcileRestoredBundle } from "../operations/restore-authority/restore-reconciliation.js";
import {
  createBackupInventory,
  readVerifiedBundle,
} from "../operations/retention/retention-backups.boundary.js";
import { retentionGraphReader } from "../operations/retention/retention-graph.js";
import { createRetentionService } from "../operations/retention/retention-service.js";
import { RetentionPreviewRequestSchema, type PreviewArtifact } from "../operations/schemas.js";
import { createApplicationAuditStores } from "../operations/storage/application-audit-store.js";
import { parseStorageConfiguration } from "../operations/storage/configuration.js";
import { createSqliteAuditIndexEvidence } from "../operations/storage/sqlite-audit-index-evidence.js";
import {
  createSqliteDeletionIndex,
  initializeDeletionIndex,
} from "../operations/storage/sqlite-deletion-index.js";
import { acquireInstallation, type OwnedInstallation } from "../operator-cli/installation-lock.js";
import {
  createInstallationTransfer,
  recordedTransferDestination,
  type TransferStep,
} from "./installation-transfer.js";
import { readOperationsConfig, type OperationsConfig } from "./operations-config.js";
import { upgradeProfilesOffline } from "./profile-upgrade.js";
import type { TransferContinuation } from "./transfer-schemas.js";
function unavailable(): OperatorCliError {
  return new OperatorCliError("prerequisite-unavailable");
}

/**
 * Exclusive offline composition for one command. The caller holds the installation lock for
 * the whole command, so maintenance runs directly on the single writable handle opened here.
 * Nothing but `activate` opens an installation whose retention audit schema is not active.
 */
/** How another installation is owned and read for a two-root transfer. */
export interface TransferInstallations {
  readonly acquire: (root: string) => OwnedInstallation | Promise<OwnedInstallation>;
  readonly read: (root: string) => OperationsConfig;
  readonly durable?: (step: TransferStep) => void;
  readonly profileUpgradeDurable?: (step: "backed-up" | "migrated") => void;
}

export function createOperationsApplication(
  capability: InstallationCapability,
  config: OperationsConfig,
  now: () => string,
  installations: TransferInstallations = {
    acquire: acquireInstallation,
    read: readOperationsConfig,
  },
): OperationsApplication {
  capability.assertOwned();
  const legacyVersion = createMigrationCatalog().length;
  const auditVersion = createAuditMigrationCatalog().length;
  const profileVersion = createProfileMigrationCatalog().length;
  const schemaVersion = existsSync(config.databasePath)
    ? inspectSqliteSchemaVersion({ databasePath: config.databasePath })
    : null;
  let educational = schemaVersion === createEducationalMigrationCatalog().length;
  let profiles = educational || schemaVersion === profileVersion;
  const activated = schemaVersion === auditVersion || profiles;
  const storageConfiguration = parseStorageConfiguration({
    installationRoot: capability.installationRoot,
    databasePath: config.databasePath,
    indexPath: config.indexPath,
    authorityLineage: config.authorityLineage,
    rootId: config.rootId,
    databaseLineage: config.databaseLineage,
  });
  const backups = createBackupInventory({ backupRoot: config.backupRoot, limits: config.limits });
  let storage: SqliteStorage | undefined;
  let indexFile: SqliteDatabaseFile | undefined;
  const open = () => {
    if (!activated) throw unavailable();
    storage ??= initializeSqliteStorage({
      databasePath: config.databasePath,
      schema: educational
        ? "educational-insights"
        : profiles
          ? "dashboard-profiles"
          : "retention-audit",
    });
    indexFile ??= openSqliteDatabaseFile({ databasePath: config.indexPath });
    return { storage, indexDatabase: indexFile.database };
  };
  const services = (clock: () => string = now) => {
    const { storage: opened, indexDatabase } = open();
    const database = opened.database;
    const index = createSqliteDeletionIndex(indexDatabase, storageConfiguration);
    const auditFor = (target: SqliteApplicationDatabase) =>
      createApplicationAuditStores(
        target,
        createSqliteAuditIndexEvidence(indexDatabase, storageConfiguration),
      );
    const graph = retentionGraphReader(database, backups.list.bind(backups), clock);
    const coordinator: MaintenanceCoordinator = {
      preview: (operation) =>
        operation({
          database: {
            readAll: (sql, parameters) => database.readAll(sql, parameters),
            readOne: (sql, parameters) => database.readOne(sql, parameters),
          },
          graph,
        }),
      run: (_input, operation) => {
        capability.assertOwned();
        return operation({ database, graph });
      },
    };
    const retention = createRetentionService({
      coordinator,
      index,
      backups,
      installation: {
        authorityLineage: config.authorityLineage,
        rootId: config.rootId,
        databaseLineage: config.databaseLineage,
      },
      auditFor,
    });
    const recovery = createDeletionRecoveryService({
      coordinator: { exclusive: (operation) => operation(database) },
      index,
      backups,
      clock: { now: clock },
      auditFor,
    });
    return { opened, indexDatabase, index, coordinator, retention, recovery };
  };
  const bundleInput = (name: string) => ({
    destinationPath: join(config.backupRoot, name),
    sourceRoot: capability.installationRoot,
    files: [
      ...new Set([
        ...config.stateFiles,
        ...(existsSync(join(capability.installationRoot, "config/server-settings.json"))
          ? ["config/server-settings.json"]
          : []),
      ]),
    ],
    limits: config.limits,
  });
  const reconcileAgainstAuthority = (bundlePath: string, restored: SqliteApplicationDatabase) => {
    const { indexDatabase } = services();
    return reconcileRestoredBundle({
      bundlePath,
      limits: config.limits,
      restored,
      destination: { authorityLineage: config.authorityLineage, rootId: config.rootId },
      indexFor: (reader) => createSqliteDeletionIndex(indexDatabase, storageConfiguration, reader),
    });
  };
  const restoreOutcome = async (bundlePath: string, restored: SqliteApplicationDatabase) => {
    const reconciliation = await reconcileAgainstAuthority(bundlePath, restored);
    const current = await services().index.inspect();
    // Unknown ancestry resurrects nothing while this authority has never recorded a deletion.
    const unrecorded =
      reconciliation.reasonCode === "unknown-ancestry" &&
      current.state === "active" &&
      current.generation === 0 &&
      current.pendingCheckpoint === null;
    return {
      accepted: reconciliation.state === "verified" || unrecorded,
      reasonCode: unrecorded ? ("no-deletions-recorded" as const) : reconciliation.reasonCode,
      checked: reconciliation.checked,
      tombstoned: reconciliation.tombstoned.length,
    };
  };
  const recordedDestination = () => {
    const destination = recordedTransferDestination(config);
    if (destination === undefined) throw new TeacherDomainError("request.conflict");
    return destination;
  };
  /** Owns the destination installation for one transfer operation over the open source stores. */
  const transferWith = async function <T>(
    destinationRoot: string,
    operation: (transfer: ReturnType<typeof createInstallationTransfer>) => T,
  ): Promise<T> {
    if (
      isInside(destinationRoot, capability.installationRoot) ||
      isInside(capability.installationRoot, destinationRoot)
    )
      throw new OperatorCliError("invalid-input");
    const { storage: opened, indexDatabase } = open();
    const owned = await installations.acquire(destinationRoot);
    let result: T;
    try {
      result = operation(
        createInstallationTransfer({
          source: {
            installationRoot: capability.installationRoot,
            config,
            storage: () => opened,
            indexDatabase: () => indexDatabase,
          },
          destination: {
            installationRoot: destinationRoot,
            config: installations.read(destinationRoot),
          },
          durable: installations.durable,
        }),
      );
      owned.capability.assertOwned();
    } catch (error) {
      owned.release();
      throw error;
    }
    if (!owned.release()) throw new OperatorCliError("ownership-uncertain");
    return result;
  };
  const application: OperationsApplication = Object.freeze({
    async initializeServerSettings(userId: string, backupName: string) {
      const prepared = prepareServerSettings(capability, services().opened.database, userId);
      await application.createBackup(backupName);
      return { administrator: userId, ...commitServerSettings(capability, prepared) };
    },
    initialize() {
      // A clean installation starts from no database; an existing one is never reinitialized.
      if (schemaVersion !== null) throw new TeacherDomainError("request.conflict");
      return application.activate();
    },
    activate() {
      if (!existsSync(config.databasePath)) writeFileSync(config.databasePath, "", { mode: 0o600 });
      // Resumable: the index is ensured first, so an interrupted activation never leaves an
      // audit-activated database without authority; an existing index must match this lineage.
      // A private empty file makes SQLite create the index and its sidecars owner-only.
      if (!existsSync(config.indexPath)) writeFileSync(config.indexPath, "", { mode: 0o600 });
      const file = openSqliteDatabaseFile({ databasePath: config.indexPath });
      try {
        initializeDeletionIndex(file.database, storageConfiguration);
      } finally {
        file.close();
      }
      const upgraded = initializeSqliteStorage({
        databasePath: config.databasePath,
        schema: educational
          ? "educational-insights"
          : profiles
            ? "dashboard-profiles"
            : "retention-audit",
      });
      try {
        return { schemaVersion: upgraded.schema.version };
      } finally {
        upgraded.close();
      }
    },
    async upgradeProfiles(name: string) {
      const result = await upgradeProfilesOffline(
        capability,
        config,
        async () => {
          const backup = await application.createBackup(name);
          open().storage.close();
          storage = undefined;
          return backup.path;
        },
        installations.profileUpgradeDurable,
      );
      profiles = true;
      educational = true;
      return result;
    },
    async preview(input: PreviewInput) {
      const { retention, index } = services();
      const createdAt = now();
      return retention.preview(
        RetentionPreviewRequestSchema.parse({
          ...input,
          authorityLineage: config.authorityLineage,
          installationId: config.rootId,
          sourceDatabaseLineage: config.databaseLineage,
          expectedIndexGeneration: (await index.inspect()).generation,
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + PREVIEW_LIFETIME_MS).toISOString(),
        }),
      );
    },
    confirm(artifact: PreviewArtifact) {
      const at = now();
      return services().retention.confirm({ artifact, now: at, drainUntil: at });
    },
    inspect(operationId: string | undefined) {
      return services().recovery.inspect(operationId);
    },
    continueExact(input: ContinueInput) {
      // The command already owns the installation, so nothing drains: the deadline is the one
      // instant the recovery service also observes, which a later clock reading would expire.
      const at = now();
      return services(() => at).recovery.continueExact({
        ...input,
        action: "continue-exact",
        authorityLineage: storageConfiguration.authorityLineage,
        drainUntil: at,
      });
    },
    markFailed(input: MarkFailedInput) {
      return services().recovery.markFailed({
        ...input,
        action: "mark-failed",
        authorityLineage: storageConfiguration.authorityLineage,
      });
    },
    async createBackup(name: string) {
      // Before activation (the pre-upgrade backup) there is no deletion authority to record.
      if (!activated) {
        if (schemaVersion !== legacyVersion) throw unavailable();
        const legacy = initializeSqliteStorage({ databasePath: config.databasePath });
        try {
          const created = createRecoveryBundle(bundleInput(name).destinationPath, {
            ...bundleInput(name),
            release: { id: config.releaseId, schemaVersion: legacyVersion },
            createBackup: legacy,
            createExclusive: (operation) => operation(),
          });
          return { path: created.path, files: created.manifest.files.length };
        } finally {
          legacy.close();
        }
      }
      const { opened, index, coordinator } = services();
      const bundle = await createAuthorizedRecoveryBundle({
        coordinator,
        index,
        drainUntil: now(),
        destinationPath: bundleInput(name).destinationPath,
        bundle: {
          ...bundleInput(name),
          // Bundles record the schema the captured database actually has.
          release: { id: config.releaseId, schemaVersion: opened.schema.version },
          createBackup: opened,
        },
      });
      return { path: bundle.path, files: bundle.manifest.files.length };
    },
    async reconcile(input: ReconcileInput) {
      const restored = openSqliteDatabaseFile({ databasePath: input.restoredDatabasePath });
      try {
        return await reconcileAgainstAuthority(input.bundlePath, restored.database);
      } finally {
        restored.close();
      }
    },
    async restore(input: RestoreInput): Promise<RestoreResult> {
      const destination = input.destinationRoot;
      const parent = dirname(destination);
      try {
        if (
          isInside(destination, capability.installationRoot) ||
          isInside(capability.installationRoot, destination) ||
          realpathSync(parent) !== parent ||
          privateKind(parent, currentUid()) !== "directory"
        )
          throw new Error();
      } catch {
        throw new OperatorCliError("invalid-input");
      }
      const release = readVerifiedBundle(input.bundlePath, config.limits).manifest.release;
      const catalog = new Map([
        [legacyVersion, "application" as const],
        [auditVersion, "retention-audit" as const],
        [profileVersion, "dashboard-profiles" as const],
        [createEducationalMigrationCatalog().length, "educational-insights" as const],
      ]).get(release.schemaVersion);
      if (catalog === undefined) throw unavailable();
      const blocked = (reasonCode: RestoreResult["reasonCode"], checked = 0, tombstoned = 0) => ({
        state: "blocked" as const,
        reasonCode,
        schemaVersion: release.schemaVersion,
        checked,
        tombstoned,
        path: null,
      });
      // Without local deletion authority only a pre-activation bundle has nothing to reconcile.
      if (!activated && catalog !== "application") return blocked("missing-authority");
      const restored = restoreRecoveryBundle(
        { destinationRoot: destination, path: input.bundlePath, schema: catalog },
        release,
        config.limits,
      );
      let outcome: Pick<RestoreResult, "reasonCode" | "checked" | "tombstoned"> & {
        readonly accepted: boolean;
      };
      try {
        outcome = activated
          ? await restoreOutcome(input.bundlePath, restored.database)
          : { accepted: true, reasonCode: "none", checked: 0, tombstoned: 0 };
      } finally {
        restored.close();
      }
      if (!outcome.accepted) {
        rmSync(destination, { recursive: true });
        return blocked(outcome.reasonCode, outcome.checked, outcome.tombstoned);
      }
      return {
        state: "restored" as const,
        reasonCode: outcome.reasonCode,
        schemaVersion: release.schemaVersion,
        checked: outcome.checked,
        tombstoned: outcome.tombstoned,
        path: destination,
      };
    },
    transferStart(input: Parameters<OperationsApplication["transferStart"]>[0]) {
      return transferWith(input.destinationInstallation, (transfer) =>
        transfer.start(input.handoffId),
      );
    },
    transferContinue(input: TransferContinuation) {
      return transferWith(recordedDestination(), (transfer) => transfer.continue(input));
    },
    transferAbort(input: { readonly handoffId: string }) {
      return transferWith(recordedDestination(), (transfer) => transfer.abort(input.handoffId));
    },
    transferInspect() {
      const destination = recordedTransferDestination(config);
      return destination === undefined
        ? Promise.resolve(null)
        : transferWith(destination, (transfer) => transfer.inspect());
    },
    close() {
      indexFile?.close();
      storage?.close();
    },
  });
  return application;
}
