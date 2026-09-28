import { resolve } from "node:path";

import type {
  MaintenancePreviewView,
  MaintenanceRunView,
  OfflineDiagnosis,
  StartResult,
  ShutdownResult,
} from "../contracts.js";
import { IndexInspectionSchema } from "../schemas.js";
import {
  HostOperationError,
  type HostDatabaseHandle,
  type HostInstallationConfig,
  type HostRuntimeDependencies,
  type InstallationLock,
} from "./contracts.js";
import {
  SerialQueue,
  diagnosticEvidence,
  diagnosticLock,
  isTerminalRecovery,
  operationErrorCode,
  readOnlyDatabase,
  startFailure,
  startReason,
  validDeadline,
  writeStatus,
} from "./runtime-support.js";
import { controllerFor } from "./controller-registry.js";

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("unknown host failure");
}

function hasTerminalReleaseState(lock: InstallationLock): boolean {
  return lock.releaseState === "released" || lock.releaseState === "ownership-lost";
}

export class HostRuntimeController {
  readonly #queue = new SerialQueue();
  readonly #dependencies: HostRuntimeDependencies;
  #ready = false;
  #root: string | null = null;
  #releaseId: string | null = null;
  #config: HostInstallationConfig | null = null;
  #lock: InstallationLock | null = null;
  #diagnosticLock: InstallationLock | null = null;
  #database: HostDatabaseHandle | null = null;

  public constructor(dependencies: HostRuntimeDependencies) {
    this.#dependencies = dependencies;
  }

  public async start(input: {
    readonly installationRoot: string;
    readonly releaseId: string;
  }): Promise<StartResult> {
    return this.#queue.run(async () => {
      if (this.#ready) {
        // The ready state is published only after all metadata and resources exist.
        const root = this.#root as unknown as string;
        const releaseId = this.#releaseId as unknown as string;
        const config = this.#config as unknown as HostInstallationConfig;
        return root === resolve(input.installationRoot) && releaseId === input.releaseId
          ? {
              state: "ready" as const,
              releaseId,
              schemaVersion: config.schemaVersion,
            }
          : startFailure("lock");
      }
      const cleanupFailure = await this.cleanupResources();
      if (cleanupFailure !== undefined) {
        return startFailure(this.resourceFailureReason());
      }
      try {
        const lock = await this.#dependencies.exclusivity.acquire(input.installationRoot);
        this.#lock = lock;
        const root = lock.canonicalRoot;
        this.#root = root;
        let config: HostInstallationConfig;
        try {
          config = await this.#dependencies.configuration.read({
            installationRoot: root,
            requestedReleaseId: input.releaseId,
          });
          await this.#dependencies.configuration.validate({
            installationRoot: root,
            config,
            requestedReleaseId: input.releaseId,
          });
        } catch (error) {
          if (error instanceof HostOperationError) throw error;
          throw new HostOperationError(
            "invalid-input",
            error instanceof Error ? error.message : String(error),
          );
        }
        this.#config = config;
        this.#releaseId = config.releaseId;
        await this.validateReadyState();
        await writeStatus(this.#dependencies, root, config, "starting", "starting");
        try {
          this.#database = await this.#dependencies.storage.open({
            installationRoot: root,
            config,
            mode: "read-write",
          });
        } catch (error) {
          throw new HostOperationError(
            "not-ready",
            error instanceof Error ? error.message : String(error),
          );
        }
        await writeStatus(this.#dependencies, root, config, "ready", "ready");
        this.#ready = true;
        return { state: "ready", releaseId: config.releaseId, schemaVersion: config.schemaVersion };
      } catch (error) {
        const cleanupFailure = await this.cleanupResources();
        if (cleanupFailure !== undefined) return startFailure(this.resourceFailureReason());
        return startFailure(startReason(error));
      }
    });
  }

  public async shutdown(input: { readonly drainUntil: string }): Promise<ShutdownResult> {
    return this.#queue.run(async () => {
      if (!this.#ready) {
        const cleanupFailure = await this.cleanupResources();
        if (cleanupFailure !== undefined) {
          return { state: "failed", reasonCode: operationErrorCode(cleanupFailure) };
        }
        return { state: "stopped", reasonCode: "not-running" };
      }
      // The ready state is published only after all four resources are assigned.
      const root = this.#root as unknown as string;
      const config = this.#config as unknown as HostInstallationConfig;
      this.#ready = false;
      let result: ShutdownResult = { state: "stopped", reasonCode: "stopped" };
      try {
        if (!validDeadline(input.drainUntil, this.#dependencies.clock.now()))
          throw new HostOperationError("drain-expired", input.drainUntil);
        await writeStatus(this.#dependencies, root, config, "draining", "shutdown");
        const drained = await this.#dependencies.drain.drain(input);
        if (drained === "expired") result = { state: "drain-expired", reasonCode: "drain-expired" };
      } catch (error) {
        result = {
          state: "failed",
          reasonCode: operationErrorCode(error),
        };
      }
      const closeFailure = await this.closeDatabase();
      if (closeFailure !== undefined) {
        result = { state: "failed", reasonCode: operationErrorCode(closeFailure) };
        try {
          await writeStatus(this.#dependencies, root, config, "failed", result.reasonCode);
        } catch {
          result = { state: "failed", reasonCode: "status-write-failed" };
        }
      } else {
        try {
          await writeStatus(
            this.#dependencies,
            root,
            config,
            result.state === "failed" ? "failed" : "stopped",
            result.reasonCode,
          );
        } catch {
          result = { state: "failed", reasonCode: "status-write-failed" };
        }
        const releaseFailure = await this.releaseLock();
        if (releaseFailure !== undefined)
          result = { state: "failed", reasonCode: operationErrorCode(releaseFailure) };
      }
      return result;
    });
  }

  public async offlineDiagnose(input: {
    readonly installationRoot: string;
  }): Promise<OfflineDiagnosis> {
    return this.#queue.run(async () => {
      const now = this.#dependencies.clock.now();
      const retainedCleanupFailure = await this.releaseDiagnosticLock();
      if (retainedCleanupFailure !== undefined) {
        return {
          mode: "live-host-observed",
          observedAt: now,
          status: "unknown",
          releaseId: null,
          schemaVersion: null,
          checks: ["stale-status"],
          reasonCode: "lock-unknown",
        };
      }
      const lockState = await this.#dependencies.exclusivity.inspect(input.installationRoot);
      const diagnosisLock = await diagnosticLock(
        this.#dependencies,
        input.installationRoot,
        lockState,
      );
      const evidence = await diagnosticEvidence(
        this.#dependencies,
        input.installationRoot,
        diagnosisLock,
        diagnosisLock !== null ? "lock-free" : lockState === "held" ? "lock-held" : "stale-status",
      );
      this.#diagnosticLock = evidence.lock;
      const config = evidence.config;
      const status = evidence.status;
      const checks = evidence.checks;
      return {
        mode:
          diagnosisLock === null || evidence.cleanupUncertain
            ? "live-host-observed"
            : "offline-validation",
        observedAt: now,
        status: status?.status ?? "unknown",
        releaseId: config?.releaseId ?? null,
        schemaVersion: config?.schemaVersion ?? null,
        checks,
        reasonCode:
          diagnosisLock === null || evidence.cleanupUncertain
            ? "lock-unknown"
            : (status?.reasonCode ?? "diagnosed"),
      };
    });
  }

  public async preview<T>(operation: (view: MaintenancePreviewView) => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      await this.ensureResourcesClean();
      if (this.#ready) {
        const view: MaintenancePreviewView = {
          database: readOnlyDatabase(this.requireDatabase()),
          graph: this.requireGraph(),
        };
        return operation(view);
      }
      return this.withStandalone("read-only", (database) =>
        operation({ database: readOnlyDatabase(database), graph: this.requireGraph() }),
      );
    });
  }

  public async run<T>(
    input: { readonly drainUntil: string },
    operation: (view: MaintenanceRunView) => Promise<T>,
  ): Promise<T> {
    return this.#queue.run(async () => {
      await this.ensureResourcesClean();
      if (!validDeadline(input.drainUntil, this.#dependencies.clock.now()))
        throw new HostOperationError("drain-expired", "drain deadline is invalid or expired");
      if (this.#ready) {
        try {
          if ((await this.#dependencies.drain.drain(input)) === "expired")
            throw new HostOperationError("drain-expired", "drain deadline expired");
          return await operation({
            database: this.requireDatabase()
              .database as import("@marea/sqlite-storage").SqliteApplicationDatabase,
            graph: this.requireGraph(),
          });
        } finally {
          this.#dependencies.drain.resume();
          this.#ready = true;
        }
      }
      return this.withStandalone("read-write", async (database) => {
        try {
          if ((await this.#dependencies.drain.drain(input)) === "expired")
            throw new HostOperationError("drain-expired", "drain deadline expired");
          return await operation({
            database:
              database.database as import("@marea/sqlite-storage").SqliteApplicationDatabase,
            graph: this.requireGraph(),
          });
        } finally {
          this.#dependencies.drain.resume();
        }
      });
    });
  }

  private async openStandalone(mode: "read-only" | "read-write") {
    const lock = await this.#dependencies.exclusivity.acquire(this.requireInstallationRoot());
    this.#lock = lock;
    this.#root = lock.canonicalRoot;
    try {
      const config = await this.#dependencies.configuration.read({
        installationRoot: lock.canonicalRoot,
      });
      await this.#dependencies.configuration.validate({
        installationRoot: lock.canonicalRoot,
        config,
        requestedReleaseId: config.releaseId,
      });
      this.#config = config;
      this.#releaseId = config.releaseId;
      await this.validateReadyState();
      this.#database = await this.#dependencies.storage.open({
        installationRoot: lock.canonicalRoot,
        config,
        mode,
      });
      return this.#database;
    } catch (error) {
      const cleanupFailure = await this.cleanupResources();
      if (cleanupFailure !== undefined) throw asError(cleanupFailure);
      throw asError(error);
    }
  }

  private async withStandalone<T>(
    mode: "read-only" | "read-write",
    operation: (database: HostDatabaseHandle) => Promise<T>,
  ): Promise<T> {
    await this.openStandalone(mode);
    let result!: T;
    let operationFailure: Error | undefined;
    try {
      result = await operation(this.requireDatabase());
    } catch (error) {
      operationFailure = asError(error);
    }
    const cleanupFailure = await this.cleanupResources();
    if (cleanupFailure !== undefined) throw asError(cleanupFailure);
    if (operationFailure !== undefined) throw operationFailure;
    return result;
  }

  private resourceFailureReason(): Extract<StartResult, { state: "failed" }>["reason"] {
    return this.#database === null ? "lock" : "storage";
  }

  private async closeDatabase(): Promise<Error | undefined> {
    const database = this.#database;
    if (database === null) return undefined;
    try {
      await database.close();
      this.#database = null;
      return undefined;
    } catch (error) {
      return asError(error);
    }
  }

  private async releaseLock(): Promise<Error | undefined> {
    const lock = this.#lock;
    if (lock === null) return undefined;
    try {
      await lock.release();
      this.#lock = null;
      return undefined;
    } catch (error) {
      if (hasTerminalReleaseState(lock)) this.#lock = null;
      return asError(error);
    }
  }

  private async cleanupResources(): Promise<Error | undefined> {
    const diagnosticFailure = await this.releaseDiagnosticLock();
    if (diagnosticFailure !== undefined) return diagnosticFailure;
    const closeFailure = await this.closeDatabase();
    if (closeFailure !== undefined) return closeFailure;
    return this.releaseLock();
  }

  private async releaseDiagnosticLock(): Promise<Error | undefined> {
    const lock = this.#diagnosticLock;
    if (lock === null) return undefined;
    try {
      await lock.release();
      this.#diagnosticLock = null;
      return undefined;
    } catch (error) {
      if (hasTerminalReleaseState(lock)) this.#diagnosticLock = null;
      return asError(error);
    }
  }

  private async ensureResourcesClean(): Promise<void> {
    if (this.#ready) return;
    const cleanupFailure = await this.cleanupResources();
    if (cleanupFailure !== undefined) {
      throw new HostOperationError(
        operationErrorCode(cleanupFailure),
        "host resources could not be cleaned up",
      );
    }
  }

  private requireGraph() {
    if (this.#dependencies.graph === undefined)
      throw new HostOperationError("not-ready", "maintenance reference graph is unavailable");
    return this.#dependencies.graph;
  }

  private requireDatabase(): HostDatabaseHandle {
    // Callers reach this helper only from the ready state, where start has set the handle.
    return this.#database as unknown as HostDatabaseHandle;
  }

  private async validateReadyState(): Promise<void> {
    const recovery = await this.#dependencies.recovery.inspect();
    if (!isTerminalRecovery(recovery))
      throw new HostOperationError("uncertain", "recovery requires operator review");
    let index;
    try {
      index = IndexInspectionSchema.parse(await this.#dependencies.index.inspect());
    } catch {
      throw new HostOperationError("corrupt", "operation index cannot be validated");
    }
    if (index.state === "corrupt")
      throw new HostOperationError("corrupt", "operation index is not ready");
    if (index.state !== "active")
      throw new HostOperationError("uncertain", "operation index is not ready");
    if (index.pendingCheckpoint !== null)
      throw new HostOperationError("uncertain", "operation index is not ready");
  }

  private requireInstallationRoot(): string {
    if (this.#dependencies.installationRoot === undefined)
      throw new HostOperationError("invalid-input", "maintenance installation root is unavailable");
    return this.#dependencies.installationRoot;
  }
}

export function createHostRuntime(
  dependencies: HostRuntimeDependencies & { readonly installationRoot: string },
) {
  const controller = controllerFor(dependencies, HostRuntimeController);
  return Object.freeze({
    lifecycle: Object.freeze({
      start: controller.start.bind(controller),
      shutdown: controller.shutdown.bind(controller),
      offlineDiagnose: controller.offlineDiagnose.bind(controller),
    }),
    maintenance: Object.freeze({
      preview: controller.preview.bind(controller),
      run: controller.run.bind(controller),
    }),
  });
}
