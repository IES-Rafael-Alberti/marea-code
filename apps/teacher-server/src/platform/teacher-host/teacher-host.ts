import {
  startTelemetryRuntime,
  type TelemetryRuntimeOptions,
} from "../telemetry/runtime-startup.js";
import { privateTelemetryResolver } from "../telemetry/private-resolver.boundary.js";
import { observeServerOperation } from "../telemetry/operation.js";
import { withTelemetryPreview } from "../telemetry/telemetry-composition.js";
import { composeBundledDashboardProfiles } from "./bundled-profile-composition.js";
import {
  DashboardReleaseError,
  type DashboardReleaseDiagnostic,
} from "../../dashboard-profiles/release.js";
import type { InferenceDiagnosticSink } from "../../model-gateway/inference-failure.boundary.js";
import { readFileSync } from "node:fs";

import { MAX_TEACHING_CONFIGURATION_BYTES } from "@marea/protocol";
import {
  createAuditMigrationCatalog,
  createProfileMigrationCatalog,
  createEducationalMigrationCatalog,
  initializeSqliteStorage,
  inspectSqliteSchemaVersion,
  openSqliteDatabaseFile,
  type SqliteApplicationDatabase,
  type SqliteDatabaseFile,
} from "@marea/sqlite-storage";
import { inferenceProviderCatalog, telemetryExporterCatalog } from "@marea/plugin-runtime";

import {
  createDashboardAssetHandler,
  loadFileSystemDashboardAssets,
} from "../../dashboard-assets/index.js";
import type { PasswordHasher } from "../../identity/contracts.js";
import {
  createHmacSecretDigest,
  cryptoIdGenerator,
  cryptoSecretIssuer,
  systemClock,
} from "../../identity/system-security.boundary.js";
import { managedProviderResolver } from "../../model-gateway/managed-provider-resolver.js";
import { serverSettingsStore } from "./server-settings-store.boundary.js";
import { protocolError } from "../../product-http/response.js";
import { createTeacherProductHttp } from "../../product-http/teacher-product-http.boundary.js";
import { BundledSkillSource } from "../../teaching/skills/bundled-skill-source.boundary.js";
import { createSharedInstallationExclusivity } from "../installation/shared-installation-exclusivity.js";
import { loadOperatorConfiguration } from "../operator/operator-filesystem-loader.js";
import {
  personalOwnerForClass,
  readOperatorCliConfig,
  type OperatorCliConfig,
} from "../operator-cli/composition.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import type { StartResult } from "../operations/contracts.js";
import { inspectHostRecovery } from "../operations/deletion-recovery/deletion-recovery.js";
import { createAccountCreationGuard } from "../operations/deletion-protection/account-creation-guard.js";
import { createHostRuntime } from "../operations/host/runtime.js";
import { FilesystemInstallationExclusivity } from "../operations/host/filesystem-exclusivity.js";
import type {
  HostConfigurationPort,
  HostDatabaseHandle,
  HostInstallationConfig,
} from "../operations/host/contracts.js";
import {
  canonicalizeStorageConfiguration,
  parseStorageConfiguration,
  type StorageConfiguration,
} from "../operations/storage/configuration.js";
import {
  createSqliteCreationGate,
  createSqliteDeletionIndex,
} from "../operations/storage/sqlite-deletion-index.js";
import {
  readOperationsConfig,
  type OperationsConfig,
} from "../operations-cli/operations-config.js";
import { captured as required } from "./captured.js";
import { createFileHostStatus } from "./host-status.boundary.js";
import { RequestDrain } from "./request-drain.js";
import { createRetryScheduler } from "./retry-scheduler.boundary.js";
import {
  readTeacherHostConfig,
  unavailable,
  type TeacherHostConfig,
} from "./teacher-host-config.js";
import { composeTeacherServices, type TeacherHostServiceDependencies } from "./teacher-services.js";

/** The network listener of a compiled host; tests may serve requests without binding a socket. */
export type ServePort = (options: {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (request: Request) => Promise<Response>;
}) => { readonly url: string; stop(): Promise<void> };

export interface TeacherHostOptions {
  readonly telemetry?: Pick<TelemetryRuntimeOptions, "catalog" | "resolver">;
  readonly startupSignal?: AbortSignal;
  /** Requires an offline upgrade to schema 10 and a validated matching dashboard release. */
  readonly profiles?: TeacherHostServiceDependencies["profiles"];
  readonly installationRoot: string;
  readonly releaseId: string;
  readonly serve: ServePort;
  readonly passwords: PasswordHasher;
  readonly onInferenceDiagnostic?: InferenceDiagnosticSink | undefined;
  /** Operator-private; receives only recognized bounded release diagnostics, never caught text. */
  readonly onStartupDiagnostic?: ((diagnostic: DashboardReleaseDiagnostic) => void) | undefined;
  readonly onEvaluationError: () => void;
}

export interface RunningTeacherHost {
  readonly state: "ready";
  readonly url: string;
  /** Drains requests within the configured deadline, stops background work and releases ownership. */
  stop(): Promise<
    Awaited<ReturnType<ReturnType<typeof createHostRuntime>["lifecycle"]["shutdown"]>>
  >;
}

interface LoadedConfiguration {
  readonly host: TeacherHostConfig;
  readonly operator: OperatorCliConfig;
  readonly operations: OperationsConfig;
  readonly storage: StorageConfiguration;
}

function storageConfigurationOf(root: string, operations: OperationsConfig): StorageConfiguration {
  return canonicalizeStorageConfiguration(
    parseStorageConfiguration({
      installationRoot: root,
      databasePath: operations.databasePath,
      indexPath: operations.indexPath,
      authorityLineage: operations.authorityLineage,
      rootId: operations.rootId,
      databaseLineage: operations.databaseLineage,
    }),
  );
}

/** Host ports whose state (configuration, index, storage) is captured for composition after start. */
function hostPorts(root: string, profiles: boolean) {
  const state: {
    configuration?: LoadedConfiguration;
    profiles?: boolean;
    index?: SqliteDatabaseFile;
    handle?: HostDatabaseHandle;
  } = {};
  const loaded = (): LoadedConfiguration => required(state.configuration);
  const indexDatabase = () => {
    state.index ??= openSqliteDatabaseFile({ databasePath: loaded().operations.indexPath });
    return state.index.database;
  };
  const configuration: HostConfigurationPort = {
    read: () => {
      const operator = readOperatorCliConfig(root);
      const operations = readOperationsConfig(root);
      const host = readTeacherHostConfig(root);
      state.configuration = {
        host,
        operator,
        operations,
        storage: storageConfigurationOf(root, operations),
      };
      const educational =
        inspectSqliteSchemaVersion({ databasePath: operator.databasePath }) ===
        createEducationalMigrationCatalog().length;
      state.profiles =
        educational ||
        profiles ||
        inspectSqliteSchemaVersion({ databasePath: operator.databasePath }) ===
          createProfileMigrationCatalog().length;
      return Promise.resolve<HostInstallationConfig>({
        releaseId: host.releaseId,
        schemaVersion: educational
          ? createEducationalMigrationCatalog().length
          : state.profiles
            ? createProfileMigrationCatalog().length
            : createAuditMigrationCatalog().length,
        databasePath: operator.databasePath,
        indexPath: operations.indexPath,
        statusPath: host.statusPath,
      });
    },
    validate: ({ config, requestedReleaseId }) =>
      config.releaseId === requestedReleaseId &&
      loaded().operations.databasePath === config.databasePath &&
      inspectSqliteSchemaVersion({ databasePath: config.databasePath }) === config.schemaVersion
        ? Promise.resolve()
        : Promise.reject(unavailable()),
  };
  const recovery = {
    // Host startup only needs the index proof; operation audit records belong to recovery commands.
    inspect: () =>
      inspectHostRecovery(createSqliteDeletionIndex(indexDatabase(), loaded().storage)),
  };
  return {
    state,
    loaded,
    indexDatabase,
    dependencies: {
      configuration,
      exclusivity: createSharedInstallationExclusivity(
        new FilesystemInstallationExclusivity(),
        acquireInstallation,
      ),
      recovery,
      index: {
        inspect: () => createSqliteDeletionIndex(indexDatabase(), loaded().storage).inspect(),
      },
      storage: {
        open: ({
          config,
          mode,
        }: {
          readonly config: HostInstallationConfig;
          readonly mode: HostDatabaseHandle["mode"];
        }) => {
          const storage = initializeSqliteStorage({
            databasePath: config.databasePath,
            schema:
              inspectSqliteSchemaVersion({ databasePath: loaded().operator.databasePath }) ===
              createEducationalMigrationCatalog().length
                ? "educational-insights"
                : state.profiles
                  ? "dashboard-profiles"
                  : "retention-audit",
          });
          state.handle = {
            mode,
            database: storage.database,
            close: () => {
              storage.close();
            },
          };
          return Promise.resolve(state.handle);
        },
      },
      status: createFileHostStatus(),
      clock: systemClock,
    },
  };
}

/** Real services from the captured configuration; nothing starts until the host commits to serving. */
async function composeHostServices(
  options: TeacherHostOptions,
  ports: ReturnType<typeof hostPorts>,
) {
  const { host, operator } = ports.loaded();
  const database = required(ports.state.handle).database as SqliteApplicationDatabase;
  const settings = serverSettingsStore(options.installationRoot);
  return composeTeacherServices({
    serverSettings: { store: settings, catalog: inferenceProviderCatalog },
    profiles:
      options.profiles ?? (ports.state.profiles ? composeBundledDashboardProfiles : undefined),
    database,
    clock: systemClock,
    ids: cryptoIdGenerator,
    secrets: cryptoSecretIssuer,
    digest: createHmacSecretDigest(new Uint8Array(readFileSync(host.digestKeyPath))),
    passwords: options.passwords,
    dummyPasswordHash: await options.passwords.hash(cryptoSecretIssuer.issue()),
    operator: loadOperatorConfiguration(
      operator.operatorPolicyPath,
      MAX_TEACHING_CONFIGURATION_BYTES,
    ),
    skills: {
      core: new BundledSkillSource(operator.coreSourcePath),
      centers: new Map(operator.centers.map((owner) => [owner.id, owner.root])),
      teachers: new Map(operator.teachers.map((owner) => [owner.id, owner.root])),
      operatorPersonalOwnerForClass: personalOwnerForClass(operator),
    },
    providers: managedProviderResolver(
      inferenceProviderCatalog,
      () => settings.read(),
      Object.fromEntries(
        host.providers.map(({ pluginId, credentialPath, ...configuration }) => [
          pluginId,
          { ...configuration, apiKey: readFileSync(credentialPath, "utf8") },
        ]),
      ),
    ),
    retry: createRetryScheduler(host.retry),
    identities: createAccountCreationGuard(
      createSqliteCreationGate(ports.indexDatabase(), ports.loaded().storage),
    ),
    evaluationIntervalMs: host.evaluationIntervalMs,
    educationalInsights: host.educationalInsights,
    onEvaluationError: options.onEvaluationError,
    onInferenceDiagnostic: options.onInferenceDiagnostic,
  });
}

/** Cleanup has already completed; a failing private sink cannot change the public outcome. */
function reportStartupDiagnostic(
  sink: (diagnostic: DashboardReleaseDiagnostic) => void,
  error: unknown,
) {
  if (!(error instanceof DashboardReleaseError)) return;
  try {
    sink({ ...error.diagnostic });
  } catch {
    // The failure object stays public-safe and ownership is already released.
  }
}

/**
 * Starts the production teacher host on an activated installation: exclusive ownership, recovery
 * and index validation (C1), storage, real services, evaluation recovery, then the listener.
 */
export async function startTeacherHost(
  options: TeacherHostOptions,
): Promise<RunningTeacherHost | Extract<StartResult, { state: "failed" }>> {
  const ports = hostPorts(options.installationRoot, options.profiles !== undefined);
  const drain = new RequestDrain();
  const runtime = createHostRuntime({
    ...ports.dependencies,
    drain,
    installationRoot: options.installationRoot,
  });
  const started = await runtime.lifecycle.start({
    installationRoot: options.installationRoot,
    releaseId: options.releaseId,
  });
  const closeIndex = () => {
    ports.state.index?.close();
  };
  if (started.state === "failed") {
    closeIndex();
    return started;
  }
  const { host } = ports.loaded();
  const telemetry = await startTelemetryRuntime({
    configuration: host.telemetry,
    catalog: options.telemetry?.catalog ?? telemetryExporterCatalog,
    resolver: options.telemetry?.resolver ?? privateTelemetryResolver(options.installationRoot),
    signal: options.startupSignal ?? new AbortController().signal,
  });
  const abandon = async (reason: "config" | "assets" | "listen") => {
    await telemetry.runtime.close(new AbortController().signal);
    await runtime.lifecycle.shutdown({
      drainUntil: new Date(Date.now() + host.shutdownDrainMs).toISOString(),
    });
    closeIndex();
    return { state: "failed" as const, reason };
  };
  let composed: Awaited<ReturnType<typeof composeHostServices>>;
  try {
    composed = await composeHostServices(options, ports);
  } catch (error) {
    const failed = await abandon("config");
    reportStartupDiagnostic(options.onStartupDiagnostic ?? (() => undefined), error);
    return failed;
  }
  let dashboard: ReturnType<typeof createDashboardAssetHandler>;
  try {
    dashboard = createDashboardAssetHandler(
      await loadFileSystemDashboardAssets(host.dashboardDistPath),
    );
  } catch {
    return abandon("assets");
  }
  try {
    composed.evaluations.recoverAfterExclusiveStartup();
  } catch {
    return abandon("config");
  }
  const product = withTelemetryPreview(
    createTeacherProductHttp({
      allowedHosts: host.allowedHosts,
      allowedOrigins: host.allowedOrigins,
      secureDashboardCookie: host.secureDashboardCookie,
      serverVersion: host.serverVersion,
      services: composed.services,
      governance: composed.governance,
    }),
    {
      telemetry: telemetry.runtime,
      database: required(ports.state.handle).database as SqliteApplicationDatabase,
      identity: composed.services.identity,
      allowedHosts: host.allowedHosts,
      allowedOrigins: host.allowedOrigins,
    },
  );
  let server: ReturnType<ServePort>;
  try {
    server = options.serve({
      hostname: host.listen.hostname,
      port: host.listen.port,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname;
        const admitted = drain.admit(async () =>
          pathname.startsWith("/api/") || pathname.startsWith("/v1/")
            ? pathname === "/v1/runs/open" && request.method === "POST"
              ? observeServerOperation(
                  telemetry.runtime,
                  () => Promise.resolve(product.fetch(request)),
                  (response) => response.ok,
                )
              : product.fetch(request)
            : dashboard(request),
        );
        return admitted ?? Promise.resolve(protocolError(503, "server.error", true));
      },
    });
  } catch {
    // An address already in use or not available is reported, never thrown past the lock.
    return abandon("listen");
  }
  // Evaluation work starts only once the host is actually listening.
  composed.evaluations.start();
  return {
    state: "ready",
    url: server.url,
    async stop() {
      await composed.evaluations.stop();
      const drainUntil = new Date(Date.now() + host.shutdownDrainMs).toISOString();
      await drain.drain({ drainUntil });
      await telemetry.runtime.close(new AbortController().signal);
      const result = await runtime.lifecycle.shutdown({ drainUntil });
      await server.stop();
      closeIndex();
      return result;
    },
  };
}
