import { expect, vi } from "vitest";
import { Sha256DigestSchema } from "@marea/protocol";

import type { RecoveryInspection } from "../contracts.js";
import type { IndexInspection, ReferenceGraph } from "../schemas.js";
import {
  HostOperationError,
  createHostRuntime,
  type HostClock,
  type HostConfigurationPort,
  type HostDatabaseHandle,
  type HostDatabaseMode,
  type HostDrainPort,
  type HostIndexPort,
  type HostInstallationConfig,
  type HostLifecycleDependencies,
  type HostMaintenanceDependencies,
  type HostRecoveryPort,
  type HostStatus,
  type HostStatusPort,
  type HostStatusRecord,
  type HostStoragePort,
  type InstallationExclusivity,
  type InstallationLock,
} from "./index.js";

type HostPortsAreInjected = [
  HostClock,
  HostConfigurationPort,
  HostDrainPort,
  HostIndexPort,
  HostLifecycleDependencies,
  HostRecoveryPort,
  HostStatus,
  HostStatusPort,
  HostStatusRecord,
  HostStoragePort,
  InstallationExclusivity,
  InstallationLock,
];

export const hostPortsAreInjected: HostPortsAreInjected | null = null;

const digest = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
export const index: IndexInspection = {
  authorityLineage: "lineage-1" as never,
  rootId: "root-1" as never,
  databaseLineage: digest,
  generation: 1,
  state: "active",
  pendingCheckpoint: null,
};
const graph: ReferenceGraph = { digest, nodes: [], blockers: [] };
export const config: HostInstallationConfig = {
  releaseId: "release-1",
  schemaVersion: 8,
  databasePath: "data.db",
  indexPath: "index.json",
  statusPath: "status.json",
};

export const startupFailureCases = [
  ["path", "config"],
  ["invalid-input", "config"],
  ["stale-generation", "release"],
  ["missing-authority", "release"],
  ["restore-isolation", "assets"],
  ["uncertain", "index"],
  ["corrupt", "index"],
  ["missing", "index"],
  ["not-ready", "storage"],
] as const;

export function dependencyHarness(overrides: Partial<HostMaintenanceDependencies> = {}) {
  const events: string[] = [];
  const statusRecords: HostStatusRecord[] = [];
  let held = false;
  let executeCount = 0;
  const database: HostDatabaseHandle = {
    mode: "read-write",
    database: {
      execute: () => {
        executeCount += 1;
        events.push("database.execute");
      },
      readAll: () => [],
      readOne: () => undefined,
      transaction<T>(operation: () => T) {
        return operation();
      },
    },
    close: vi.fn(() => {
      events.push("database.close");
    }),
  };
  const dependencies: HostMaintenanceDependencies = {
    installationRoot: "/synthetic/installation",
    configuration: {
      read: vi.fn(() => {
        events.push("config.read");
        return Promise.resolve(config);
      }),
      validate: vi.fn(() => {
        events.push("config.validate");
        return Promise.resolve();
      }),
    },
    exclusivity: {
      acquire: vi.fn(() => {
        events.push("lock.acquire");
        if (held) return Promise.reject(new HostOperationError("owner-busy", "held"));
        held = true;
        return Promise.resolve({
          canonicalRoot: "/synthetic/installation",
          release: vi.fn(() => {
            events.push("lock.release");
            held = false;
            return Promise.resolve();
          }),
        });
      }),
      inspect: vi.fn(() => Promise.resolve(held ? ("held" as const) : ("free" as const))),
    },
    recovery: {
      inspect: vi.fn((): Promise<RecoveryInspection> =>
        Promise.resolve({
          state: "none",
          operationId: null,
          checkpoint: null,
          reasonCode: "none",
        }),
      ),
    },
    index: { inspect: vi.fn(() => Promise.resolve(index)) },
    storage: {
      open: vi.fn(({ mode }: { readonly mode: HostDatabaseMode }) => {
        events.push(`storage.open:${mode}`);
        return Promise.resolve({ ...database, mode });
      }),
    },
    status: {
      read: vi.fn(() => Promise.resolve(null)),
      write: vi.fn(({ value }: { readonly value: HostStatusRecord }) => {
        statusRecords.push(value);
        events.push(`status.write:${value.status}`);
        return Promise.resolve();
      }),
    },
    drain: {
      drain: vi.fn(() => {
        events.push("drain");
        return Promise.resolve("drained" as const);
      }),
      resume: vi.fn(() => {
        events.push("resume");
      }),
    },
    clock: { now: () => "2026-09-13T12:00:00.000Z" },
    graph: { read: vi.fn(() => Promise.resolve(graph)) },
    ...overrides,
  };
  return {
    dependencies,
    events,
    statusRecords,
    get executeCount() {
      return executeCount;
    },
  };
}

export function retryingOwner(finalState: "released" | "ownership-lost"): {
  readonly lock: InstallationLock & {
    releaseState: "owned" | "released" | "ownership-lost";
  };
  readonly attempts: number;
} {
  let attempts = 0;
  const lock = {
    canonicalRoot: "/synthetic/installation",
    releaseState: "owned" as "owned" | "released" | "ownership-lost",
    release: vi.fn(() => {
      attempts += 1;
      if (attempts === 2) lock.releaseState = finalState;
      return Promise.reject(
        new HostOperationError("owner-busy", "installation lock ownership changed"),
      );
    }),
  };
  return {
    lock,
    get attempts() {
      return attempts;
    },
  };
}

export function releasedOwner(): InstallationLock {
  return {
    canonicalRoot: "/synthetic/installation",
    releaseState: "released" as const,
    release: vi.fn(() => Promise.resolve()),
  };
}

export function validationFailureHarness(code: string) {
  return dependencyHarness({
    configuration: {
      read: vi.fn(() => Promise.resolve(config)),
      validate: vi.fn(() => Promise.reject(new HostOperationError(code as never, code))),
    },
  });
}

export function uncertainOwner(): InstallationLock {
  return {
    canonicalRoot: "/synthetic/installation",
    release: vi.fn(() => Promise.reject(new Error("release uncertain"))),
  };
}

export function freeExclusivity(
  acquire: HostMaintenanceDependencies["exclusivity"]["acquire"],
): InstallationExclusivity {
  return {
    acquire,
    inspect: vi.fn(() => Promise.resolve("free" as const)),
  };
}

export function sequencedExclusivity(
  firstLock: InstallationLock,
  replacementLock: InstallationLock,
): { readonly exclusivity: InstallationExclusivity; readonly attempts: number } {
  let attempts = 0;
  return {
    exclusivity: {
      acquire: vi.fn(() => {
        attempts += 1;
        return Promise.resolve(attempts === 1 ? firstLock : replacementLock);
      }),
      inspect: vi.fn(() => Promise.resolve("free" as const)),
    },
    get attempts() {
      return attempts;
    },
  };
}

export function releaseFailingExclusivity(message = "release failed"): InstallationExclusivity {
  return {
    acquire: vi.fn(() =>
      Promise.resolve({
        canonicalRoot: "/synthetic/installation",
        release: vi.fn(() => Promise.reject(new Error(message))),
      }),
    ),
    inspect: vi.fn(() => Promise.resolve("free" as const)),
  };
}

export function storageWithClose(close: () => void | Promise<void>): HostStoragePort {
  return {
    open: vi.fn(async ({ mode }: { readonly mode: HostDatabaseMode }) => {
      const opened = await dependencyHarness().dependencies.storage.open({
        installationRoot: "/synthetic/installation",
        config,
        mode,
      });
      return { ...opened, close: vi.fn(async () => close()) };
    }),
  };
}

export async function expectStartupFailure(
  dependencies: HostMaintenanceDependencies,
  reason: string,
) {
  await expect(
    createHostRuntime(dependencies).lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    }),
  ).resolves.toEqual({ state: "failed", reason });
}

export async function expectShutdownFailure(
  runtime: ReturnType<typeof createHostRuntime>,
  reasonCode: string,
) {
  await expect(
    runtime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
  ).resolves.toEqual({ state: "failed", reasonCode });
}
