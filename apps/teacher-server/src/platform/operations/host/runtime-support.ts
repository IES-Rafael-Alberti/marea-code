import type {
  OfflineDiagnosis,
  ReadOnlySqliteApplicationDatabase,
  RecoveryInspection,
  StartResult,
} from "../contracts.js";
import type {
  HostDatabaseHandle,
  HostInstallationConfig,
  HostRuntimeDependencies,
  HostStatus,
  InstallationLock,
} from "./contracts.js";
import { HostOperationError } from "./contracts.js";
import { UtcTimestampSchema } from "@marea/protocol";

export class SerialQueue {
  #tail = Promise.resolve();

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function isTerminalRecovery(value: RecoveryInspection): boolean {
  return (
    (value.state === "none" || value.state === "applied" || value.state === "failed") &&
    value.checkpoint === null
  );
}

export function operationErrorCode(error: unknown): HostOperationError["code"] {
  return error instanceof HostOperationError ? error.code : "not-ready";
}

export function readOnlyDatabase(handle: HostDatabaseHandle): ReadOnlySqliteApplicationDatabase {
  return Object.freeze({
    readAll: handle.database.readAll.bind(handle.database),
    readOne: handle.database.readOne.bind(handle.database),
  });
}

export function validDeadline(value: string, now: string): boolean {
  const deadline = UtcTimestampSchema.safeParse(value);
  const current = UtcTimestampSchema.safeParse(now);
  return deadline.success && current.success && Date.parse(value) >= Date.parse(now);
}

export function startFailure(
  reason: Extract<StartResult, { state: "failed" }>["reason"],
): StartResult {
  return { state: "failed", reason };
}

export function startReason(error: unknown): Extract<StartResult, { state: "failed" }>["reason"] {
  if (error instanceof HostOperationError) {
    if (error.code === "owner-busy") return "lock";
    if (error.code === "path" || error.code === "invalid-input") return "config";
    if (error.code === "stale-generation" || error.code === "missing-authority") return "release";
    if (error.code === "restore-isolation") return "assets";
    if (error.code === "uncertain" || error.code === "corrupt" || error.code === "missing")
      return "index";
    if (error.code === "not-ready") return "storage";
  }
  return "recovery";
}

export async function writeStatus(
  dependencies: HostRuntimeDependencies,
  root: string,
  config: HostInstallationConfig,
  status: HostStatus,
  reasonCode: string,
): Promise<void> {
  await dependencies.status.write({
    installationRoot: root,
    statusPath: config.statusPath,
    value: {
      status,
      releaseId: config.releaseId,
      schemaVersion: config.schemaVersion,
      reasonCode,
      observedAt: dependencies.clock.now(),
    },
  });
}

export async function diagnosticLock(
  dependencies: HostRuntimeDependencies,
  installationRoot: string,
  lockState: "free" | "held" | "unknown",
): Promise<InstallationLock | null> {
  if (lockState !== "free") return null;
  try {
    return await dependencies.exclusivity.acquire(installationRoot);
  } catch {
    return null;
  }
}

export async function diagnosticEvidence(
  dependencies: HostRuntimeDependencies,
  installationRoot: string,
  lock: InstallationLock | null,
  observedLock: "lock-free" | "lock-held" | "stale-status",
): Promise<{
  readonly config: HostInstallationConfig | null;
  readonly status: Awaited<ReturnType<HostRuntimeDependencies["status"]["read"]>>;
  readonly checks: OfflineDiagnosis["checks"][number][];
  readonly lock: InstallationLock | null;
  readonly ownershipLost: boolean;
  readonly cleanupUncertain: boolean;
}> {
  const checks: OfflineDiagnosis["checks"][number][] = [observedLock];
  let config: HostInstallationConfig | null = null;
  let status: Awaited<ReturnType<HostRuntimeDependencies["status"]["read"]>> = null;
  let retainedLock: InstallationLock | null = null;
  let ownershipLost = false;
  let cleanupUncertain = false;
  try {
    const root = lock?.canonicalRoot ?? installationRoot;
    config = await dependencies.configuration.read({ installationRoot: root });
    await dependencies.configuration.validate({
      installationRoot: root,
      config,
      requestedReleaseId: config.releaseId,
    });
    checks.push("config-valid");
    status = await dependencies.status.read({
      installationRoot: root,
      statusPath: config.statusPath,
    });
    if (lock !== null) {
      const index = await dependencies.index.inspect();
      checks.push(
        index.state === "active" && index.pendingCheckpoint === null
          ? "index-valid"
          : "stale-status",
      );
    }
  } catch {
    checks.push("index-missing");
  }
  if (lock !== null) {
    try {
      await lock.release();
    } catch {
      checks.push("stale-status");
      ownershipLost = lock.releaseState === "ownership-lost";
      cleanupUncertain = true;
      if (lock.releaseState !== "ownership-lost" && lock.releaseState !== "released")
        retainedLock = lock;
    }
  }
  return { config, status, checks, lock: retainedLock, ownershipLost, cleanupUncertain };
}
