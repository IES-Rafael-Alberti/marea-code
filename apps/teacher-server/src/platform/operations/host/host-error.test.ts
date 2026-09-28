/* eslint-disable max-lines, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from "vitest";

import { HostRuntimeController, createHostRuntime, type HostStatusRecord } from "./index.js";
import {
  HostOperationError as HostError,
  type HostDatabaseHandle,
  type HostInstallationConfig,
} from "./contracts.js";
import {
  config as validConfig,
  dependencyHarness,
  expectStartupFailure,
  freeExclusivity,
  index,
  releasedOwner,
  retryingOwner,
  releaseFailingExclusivity,
  sequencedExclusivity,
  expectShutdownFailure,
  storageWithClose,
  startupFailureCases,
  uncertainOwner,
  validationFailureHarness,
} from "./host-test-fixtures.fixture.js";

describe("host terminal and diagnostic boundaries", () => {
  it("returns a lock failure when acquisition is rejected before ownership", async () => {
    const harness = dependencyHarness({
      exclusivity: {
        acquire: vi.fn(() => Promise.reject(new HostError("owner-busy", "held"))),
        inspect: vi.fn(() => Promise.resolve("held" as const)),
      },
    });
    await expect(
      createHostRuntime(harness.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });
    expect(harness.dependencies.configuration.read).not.toHaveBeenCalled();
  });

  it("covers known terminal recovery states and shutdown cleanup failures", async () => {
    for (const state of ["applied", "failed"] as const) {
      const harness = dependencyHarness({
        recovery: {
          inspect: vi.fn(() =>
            Promise.resolve({ state, operationId: null, checkpoint: null, reasonCode: state }),
          ),
        },
      });
      await expect(
        createHostRuntime(harness.dependencies).lifecycle.start({
          installationRoot: "/synthetic/installation",
          releaseId: "release-1",
        }),
      ).resolves.toMatchObject({ state: "ready" });
    }
    const checkpoint = dependencyHarness({
      recovery: {
        inspect: vi.fn(() =>
          Promise.resolve({
            state: "failed" as const,
            operationId: "op-1",
            checkpoint: { present: true } as never,
            reasonCode: "checkpoint",
          }),
        ),
      },
    });
    await expect(
      createHostRuntime(checkpoint.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "index" });

    const expired = dependencyHarness({
      drain: {
        drain: vi.fn(() => Promise.resolve("expired" as const)),
        resume: vi.fn(() => undefined),
      },
    });
    const expiredRuntime = createHostRuntime(expired.dependencies);
    await expiredRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      expiredRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "drain-expired", reasonCode: "drain-expired" });
    expect(expired.statusRecords.at(-1)).toMatchObject({
      status: "stopped",
      reasonCode: "drain-expired",
    });
    expect(expired.dependencies.drain.resume).not.toHaveBeenCalled();

    const drainFailure = dependencyHarness({
      drain: {
        drain: vi.fn(() => Promise.reject(new Error("drain failed"))),
        resume: vi.fn(() => undefined),
      },
    });
    const drainFailureRuntime = createHostRuntime(drainFailure.dependencies);
    await drainFailureRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      drainFailureRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toMatchObject({ state: "failed", reasonCode: "not-ready" });
    expect(drainFailure.statusRecords.at(-1)).toMatchObject({ status: "failed" });
  });

  it("diagnoses held/unknown and stale or missing offline state", async () => {
    const held = dependencyHarness({
      exclusivity: {
        acquire: vi.fn(() => Promise.reject(new Error("held"))),
        inspect: vi.fn(() => Promise.resolve("held" as const)),
      },
      status: {
        read: vi.fn(() =>
          Promise.resolve({
            status: "ready" as const,
            releaseId: "release-1",
            schemaVersion: 8,
            reasonCode: "ready",
            observedAt: "now",
          }),
        ),
        write: vi.fn(() => Promise.resolve()),
      },
    });
    await expect(
      createHostRuntime(held.dependencies).lifecycle.offlineDiagnose({
        installationRoot: "/synthetic/installation",
      }),
    ).resolves.toMatchObject({
      mode: "live-host-observed",
      status: "ready",
      checks: ["lock-held", "config-valid"],
    });
    expect(held.dependencies.index.inspect).not.toHaveBeenCalled();
    const unknown = dependencyHarness({
      exclusivity: {
        acquire: vi.fn(() => Promise.reject(new Error("held"))),
        inspect: vi.fn(() => Promise.resolve("unknown" as const)),
      },
      index: { inspect: vi.fn(() => Promise.resolve({ ...index, state: "uncertain" as const })) },
    });
    await expect(
      createHostRuntime(unknown.dependencies).lifecycle.offlineDiagnose({
        installationRoot: "/synthetic/installation",
      }),
    ).resolves.toMatchObject({
      mode: "live-host-observed",
      checks: ["stale-status", "config-valid"],
      reasonCode: "lock-unknown",
    });
    expect(unknown.dependencies.index.inspect).not.toHaveBeenCalled();
    const missing = dependencyHarness({
      configuration: {
        read: vi.fn(() => Promise.reject(new Error("missing config"))),
        validate: vi.fn(() => Promise.resolve()),
      },
    });
    await expect(
      createHostRuntime(missing.dependencies).lifecycle.offlineDiagnose({
        installationRoot: "/synthetic/installation",
      }),
    ).resolves.toMatchObject({ status: "unknown", checks: ["lock-free", "index-missing"] });

    const pendingIndex = dependencyHarness({
      status: {
        read: vi.fn(() =>
          Promise.resolve({
            status: "stopped" as const,
            releaseId: "release-1",
            schemaVersion: 8,
            reasonCode: "stopped",
            observedAt: "2026-09-13T12:00:00.000Z",
          }),
        ),
        write: vi.fn(() => Promise.resolve()),
      },
      index: {
        inspect: vi.fn(() =>
          Promise.resolve({ ...index, pendingCheckpoint: { present: true } as never }),
        ),
      },
    });
    await expect(
      createHostRuntime(pendingIndex.dependencies).lifecycle.offlineDiagnose({
        installationRoot: "/synthetic/installation",
      }),
    ).resolves.toEqual({
      mode: "offline-validation",
      observedAt: "2026-09-13T12:00:00.000Z",
      status: "stopped",
      releaseId: "release-1",
      schemaVersion: 8,
      checks: ["lock-free", "config-valid", "stale-status"],
      reasonCode: "stopped",
    });
    expect(pendingIndex.dependencies.status.read).toHaveBeenCalledWith({
      installationRoot: "/synthetic/installation",
      statusPath: "status.json",
    });
    expect(pendingIndex.dependencies.configuration.validate).toHaveBeenCalledWith({
      installationRoot: "/synthetic/installation",
      config: validConfig,
      requestedReleaseId: "release-1",
    });
    expect(pendingIndex.dependencies.configuration.read).toHaveBeenCalledWith({
      installationRoot: "/synthetic/installation",
    });
  });

  it("reports uncertain ownership when diagnostic cleanup cannot release", async () => {
    let releaseAttempts = 0;
    const acquire = vi.fn(() =>
      Promise.resolve({
        canonicalRoot: "/synthetic/installation",
        release: vi.fn(() => {
          releaseAttempts += 1;
          return releaseAttempts <= 2
            ? Promise.reject(new Error("release uncertain"))
            : Promise.resolve();
        }),
      }),
    );
    const harness = dependencyHarness({
      exclusivity: freeExclusivity(acquire),
    });
    const runtime = createHostRuntime(harness.dependencies);
    await expect(
      runtime.lifecycle.offlineDiagnose({ installationRoot: "/synthetic/installation" }),
    ).resolves.toMatchObject({
      mode: "live-host-observed",
      checks: ["lock-free", "config-valid", "index-valid", "stale-status"],
      reasonCode: "lock-unknown",
    });
    await expect(
      runtime.maintenance.preview(() => Promise.resolve("unexpected")),
    ).rejects.toMatchObject({
      code: "not-ready",
      message: "host resources could not be cleaned up",
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(releaseAttempts).toBe(2);
    await expect(
      runtime.lifecycle.offlineDiagnose({ installationRoot: "/synthetic/installation" }),
    ).resolves.toMatchObject({ mode: "offline-validation" });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(releaseAttempts).toBe(4);
  });

  it("drops a terminal diagnostic owner after reporting its final release failure", async () => {
    const firstOwner = retryingOwner("released");
    const firstLock = firstOwner.lock;
    const replacementLock = releasedOwner();
    const sequence = sequencedExclusivity(firstLock, replacementLock);
    const harness = dependencyHarness({ exclusivity: sequence.exclusivity });
    const runtime = createHostRuntime(harness.dependencies);
    await expect(
      runtime.lifecycle.offlineDiagnose({ installationRoot: "/synthetic/installation" }),
    ).resolves.toMatchObject({ mode: "live-host-observed", reasonCode: "lock-unknown" });
    await expect(
      runtime.lifecycle.offlineDiagnose({ installationRoot: "/synthetic/installation" }),
    ).resolves.toMatchObject({ mode: "live-host-observed", reasonCode: "lock-unknown" });
    await expect(
      runtime.lifecycle.offlineDiagnose({ installationRoot: "/synthetic/installation" }),
    ).resolves.toMatchObject({ mode: "offline-validation", reasonCode: "diagnosed" });
    expect(sequence.attempts).toBe(2);
    expect(firstOwner.attempts).toBe(2);
    expect(harness.dependencies.exclusivity.inspect).toHaveBeenCalledTimes(2);
  });

  it("reports stale evidence when a diagnostic owner is replaced", async () => {
    const harness = dependencyHarness({
      exclusivity: {
        acquire: vi.fn(() =>
          Promise.resolve({
            canonicalRoot: "/synthetic/installation",
            releaseState: "ownership-lost" as const,
            release: vi.fn(() => Promise.reject(new HostError("owner-busy", "replaced"))),
          }),
        ),
        inspect: vi.fn(() => Promise.resolve("free" as const)),
      },
    });
    await expect(
      createHostRuntime(harness.dependencies).lifecycle.offlineDiagnose({
        installationRoot: "/synthetic/installation",
      }),
    ).resolves.toMatchObject({
      mode: "live-host-observed",
      checks: ["lock-free", "config-valid", "index-valid", "stale-status"],
      reasonCode: "lock-unknown",
    });
  });

  it("does not reopen state while a retained diagnostic owner is uncertain", async () => {
    const acquire = vi.fn(() => Promise.resolve(uncertainOwner()));
    const harness = dependencyHarness({
      exclusivity: freeExclusivity(acquire),
    });
    const runtime = createHostRuntime(harness.dependencies);
    await runtime.lifecycle.offlineDiagnose({ installationRoot: "/synthetic/installation" });
    await expect(
      runtime.lifecycle.offlineDiagnose({ installationRoot: "/synthetic/installation" }),
    ).resolves.toMatchObject({
      mode: "live-host-observed",
      checks: ["stale-status"],
      reasonCode: "lock-unknown",
      status: "unknown",
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(harness.dependencies.index.inspect).toHaveBeenCalledOnce();
  });

  it("cleans up setup errors and validates missing maintenance roots", async () => {
    const statusWrites = vi.fn((input: { readonly value: { readonly status: string } }) =>
      input.value.status === "ready"
        ? Promise.reject(new Error("ready status"))
        : Promise.resolve(),
    );
    const statusBroken = dependencyHarness({
      status: { read: vi.fn(() => Promise.resolve(null)), write: statusWrites },
    });
    await expect(
      createHostRuntime(statusBroken.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "recovery" });
    expect(statusBroken.events).toContain("database.close");
    expect(statusBroken.events).toContain("lock.release");
    const startupReleaseFailure = dependencyHarness({
      configuration: {
        read: vi.fn(() => Promise.reject(new Error("bad config"))),
        validate: vi.fn(() => Promise.resolve()),
      },
      exclusivity: releaseFailingExclusivity(),
    });
    await expect(
      createHostRuntime(startupReleaseFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });

    let held = false;
    let releaseAttempts = 0;
    const retainedLock = dependencyHarness({
      configuration: {
        read: vi.fn(() => Promise.reject(new Error("bad config"))),
        validate: vi.fn(() => Promise.resolve()),
      },
      exclusivity: {
        acquire: vi.fn(() => {
          if (held) return Promise.reject(new HostError("owner-busy", "held"));
          held = true;
          return Promise.resolve({
            canonicalRoot: "/synthetic/installation",
            release: vi.fn(() => {
              releaseAttempts += 1;
              if (releaseAttempts > 1) held = false;
              return releaseAttempts === 1
                ? Promise.reject(new Error("release uncertain"))
                : Promise.resolve();
            }),
          });
        }),
        inspect: vi.fn(() => Promise.resolve(held ? ("held" as const) : ("free" as const))),
      },
    });
    const retainedRuntime = createHostRuntime(retainedLock.dependencies);
    await expect(
      retainedRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });
    await expect(
      retainedRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "config" });
    expect(releaseAttempts).toBe(3);

    let admissionAttempts = 0;
    const cleanupBlocked = dependencyHarness({
      exclusivity: {
        acquire: vi.fn(() => {
          admissionAttempts += 1;
          return Promise.resolve({
            canonicalRoot: "/synthetic/installation",
            release: vi.fn(() => Promise.reject(new Error("release remains uncertain"))),
          });
        }),
        inspect: vi.fn(() => Promise.resolve("held" as const)),
      },
      configuration: {
        read: vi.fn(() => Promise.reject(new Error("configuration unavailable"))),
        validate: vi.fn(() => Promise.resolve()),
      },
    });
    const cleanupBlockedRuntime = createHostRuntime(cleanupBlocked.dependencies);
    await expect(
      cleanupBlockedRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });
    await expect(
      cleanupBlockedRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });
    expect(admissionAttempts).toBe(1);

    const missingRoot = new HostRuntimeController({
      ...dependencyHarness().dependencies,
      installationRoot: undefined,
    } as never);
    await expect(
      missingRoot.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, () => Promise.resolve()),
    ).rejects.toMatchObject({
      code: "invalid-input",
      message: "maintenance installation root is unavailable",
    });
  });

  it("returns a failure when setup fails before a database or lock is opened", async () => {
    const configFailure = dependencyHarness({
      configuration: {
        read: vi.fn(() => Promise.reject(new Error("configuration unavailable"))),
        validate: vi.fn(() => Promise.resolve()),
      },
    });
    await expectStartupFailure(configFailure.dependencies, "config");
    expect(configFailure.events).toEqual(["lock.acquire", "lock.release"]);

    const genericConfigFailure = dependencyHarness({
      configuration: {
        // Exercise normalization of an untyped configuration failure.
        read: vi.fn(
          () =>
            new Promise<HostInstallationConfig>((_, reject) => {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              reject("configuration unavailable generically");
            }),
        ),
        validate: vi.fn(() => Promise.resolve()),
      },
    });
    await expect(
      createHostRuntime(genericConfigFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "config" });

    const genericStorageFailure = dependencyHarness({
      storage: {
        // Exercise normalization of an untyped storage failure.
        open: vi.fn(
          () =>
            new Promise<HostDatabaseHandle>((_, reject) => {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              reject("storage unavailable generically");
            }),
        ),
      },
    });
    await expect(
      createHostRuntime(genericStorageFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "storage" });

    const statusFailure = dependencyHarness({
      status: {
        read: vi.fn(() => Promise.resolve(null)),
        write: vi.fn(({ value }: { readonly value: HostStatusRecord }) => {
          if (value.status === "starting") return Promise.reject(new Error("status unavailable"));
          return Promise.resolve();
        }),
      },
    });
    await expectStartupFailure(statusFailure.dependencies, "recovery");
    expect(statusFailure.events).not.toContain("database.close");
    expect(statusFailure.events).toContain("lock.release");
  });

  it("closes databases and releases locks when shutdown cleanup fails", async () => {
    const closeFailureBase = dependencyHarness();
    const closeFailure = dependencyHarness({
      storage: {
        open: vi.fn(async ({ mode }: { readonly mode: "read-only" | "read-write" }) => {
          const opened = await closeFailureBase.dependencies.storage.open({
            installationRoot: "/synthetic/installation",
            config: validConfig,
            mode,
          });
          return { ...opened, close: vi.fn(() => Promise.reject(new Error("close failed"))) };
        }),
      },
    });
    const closeRuntime = createHostRuntime(closeFailure.dependencies);
    await closeRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      closeRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "failed", reasonCode: "not-ready" });
    await expect(
      closeRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "storage" });
    await expect(
      closeRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "failed", reasonCode: "not-ready" });
    expect(closeFailure.statusRecords.at(-1)).toMatchObject({
      status: "failed",
      reasonCode: "not-ready",
    });

    const closeAndStatusFailure = dependencyHarness({
      storage: storageWithClose(() => Promise.reject(new Error("close failed"))),
      status: {
        read: vi.fn(() => Promise.resolve(null)),
        write: vi.fn(({ value }: { readonly value: HostStatusRecord }) =>
          value.status === "failed"
            ? Promise.reject(new Error("status failed"))
            : Promise.resolve(),
        ),
      },
    });
    const closeAndStatusRuntime = createHostRuntime(closeAndStatusFailure.dependencies);
    await closeAndStatusRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      closeAndStatusRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "failed", reasonCode: "status-write-failed" });

    const typedCloseBase = dependencyHarness();
    const typedClose = dependencyHarness({
      storage: {
        open: vi.fn(
          async (input: {
            readonly installationRoot: string;
            readonly config: typeof validConfig;
            readonly mode: "read-only" | "read-write";
          }) => {
            const opened = await typedCloseBase.dependencies.storage.open(input);
            return {
              ...opened,
              close: vi.fn(() => Promise.reject(new HostError("path", "typed close failed"))),
            };
          },
        ),
      },
    });
    const typedCloseRuntime = createHostRuntime(typedClose.dependencies);
    await typedCloseRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      typedCloseRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "failed", reasonCode: "path" });

    const statusFailure = dependencyHarness({
      status: {
        read: vi.fn(() => Promise.resolve(null)),
        write: vi.fn(({ value }: { readonly value: { readonly status: string } }) =>
          value.status === "stopped"
            ? Promise.reject(new Error("status failed"))
            : Promise.resolve(),
        ),
      },
    });
    const statusRuntime = createHostRuntime(statusFailure.dependencies);
    await statusRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      statusRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "failed", reasonCode: "status-write-failed" });

    const lockFailure = dependencyHarness({
      exclusivity: releaseFailingExclusivity(),
    });
    const lockRuntime = createHostRuntime(lockFailure.dependencies);
    await lockRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      lockRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "failed", reasonCode: "not-ready" });
  });

  it("retains an uncertain shutdown owner and retries cleanup before admission", async () => {
    let closeAttempts = 0;
    const harness = dependencyHarness({
      storage: storageWithClose(() => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("close uncertain");
      }),
    });
    const runtime = createHostRuntime(harness.dependencies);
    await runtime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expectShutdownFailure(runtime, "not-ready");
    await expect(
      harness.dependencies.exclusivity.acquire("/synthetic/installation"),
    ).rejects.toMatchObject({
      code: "owner-busy",
    });
    await expect(
      runtime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "stopped", reasonCode: "not-running" });
    expect(closeAttempts).toBe(2);
    const replacement = await harness.dependencies.exclusivity.acquire("/synthetic/installation");
    await replacement.release();
  });

  it("reports terminal shutdown release failure before admitting a fresh owner", async () => {
    const firstOwner = retryingOwner("ownership-lost");
    const firstLock = firstOwner.lock;
    const replacementLock = releasedOwner();
    const sequence = sequencedExclusivity(firstLock, replacementLock);
    const harness = dependencyHarness({ exclusivity: sequence.exclusivity });
    const runtime = createHostRuntime(harness.dependencies);
    await runtime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      runtime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "failed", reasonCode: "owner-busy" });
    await expect(
      runtime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });
    await expect(
      runtime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(sequence.attempts).toBe(2);
    expect(firstOwner.attempts).toBe(2);
  });

  it("maps typed startup failures to their lifecycle result buckets", async () => {
    for (const [code, reason] of startupFailureCases) {
      const harness = validationFailureHarness(code);
      await expectStartupFailure(harness.dependencies, reason);
    }
  });

  it("retains startup and standalone maintenance owners when close is unproven", async () => {
    let closeAttempts = 0;
    let readyStatusAttempts = 0;
    const startup = dependencyHarness({
      storage: storageWithClose(() => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("close uncertain");
      }),
      status: {
        read: vi.fn(() => Promise.resolve(null)),
        write: vi.fn(({ value }: { readonly value: HostStatusRecord }) => {
          if (value.status === "ready" && readyStatusAttempts++ === 0)
            return Promise.reject(new Error("ready status failed"));
          return Promise.resolve();
        }),
      },
    });
    const startupRuntime = createHostRuntime(startup.dependencies);
    await expect(
      startupRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "storage" });
    await expect(
      startup.dependencies.exclusivity.acquire("/synthetic/installation"),
    ).rejects.toMatchObject({
      code: "owner-busy",
    });
    await expect(
      startupRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toMatchObject({ state: "ready" });
    await startupRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" });

    let previewCloseAttempts = 0;
    const preview = dependencyHarness({
      storage: storageWithClose(() => {
        previewCloseAttempts += 1;
        if (previewCloseAttempts === 1) throw new Error("preview close uncertain");
      }),
    });
    const previewRuntime = createHostRuntime(preview.dependencies);
    await expect(
      previewRuntime.maintenance.preview(() => Promise.resolve("preview")),
    ).rejects.toThrow("preview close uncertain");
    await expect(
      preview.dependencies.exclusivity.acquire("/synthetic/installation"),
    ).rejects.toMatchObject({
      code: "owner-busy",
    });
    await expect(previewRuntime.maintenance.preview(() => Promise.resolve("retry"))).resolves.toBe(
      "retry",
    );

    let runCloseAttempts = 0;
    const runHarness = dependencyHarness({
      storage: storageWithClose(() => {
        runCloseAttempts += 1;
        if (runCloseAttempts === 1) throw new Error("run close uncertain");
      }),
    });
    const runRuntime = createHostRuntime(runHarness.dependencies);
    await expect(
      runRuntime.maintenance.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, () =>
        Promise.resolve("run"),
      ),
    ).rejects.toThrow("run close uncertain");
    await expect(
      runHarness.dependencies.exclusivity.acquire("/synthetic/installation"),
    ).rejects.toMatchObject({
      code: "owner-busy",
    });
    await expect(
      runRuntime.maintenance.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, () =>
        Promise.resolve("retry"),
      ),
    ).resolves.toBe("retry");
  });

  it("does not inspect the index when a free observation loses its acquisition race", async () => {
    const harness = dependencyHarness();
    let acquisitionAttempts = 0;
    harness.dependencies.exclusivity.acquire = vi.fn(() => {
      acquisitionAttempts += 1;
      return Promise.reject(new HostError("owner-busy", "raced owner"));
    });
    await expect(
      createHostRuntime(harness.dependencies).lifecycle.offlineDiagnose({
        installationRoot: "/synthetic/installation",
      }),
    ).resolves.toMatchObject({ checks: ["stale-status", "config-valid"] });
    expect(acquisitionAttempts).toBe(1);
    expect(harness.dependencies.index.inspect).not.toHaveBeenCalled();
  });

  it("holds the standalone writer through draining and closes before releasing it", async () => {
    let resolveDrain!: (value: "drained") => void;
    const harness = dependencyHarness({
      drain: {
        drain: vi.fn(
          () =>
            new Promise<"drained">((resolve) => {
              resolveDrain = resolve;
            }),
        ),
        resume: vi.fn(() => undefined),
      },
    });
    const runtime = createHostRuntime(harness.dependencies);
    const run = runtime.maintenance.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, () =>
      Promise.resolve("done"),
    );
    await vi.waitFor(() => {
      expect(harness.dependencies.storage.open).toHaveBeenCalledOnce();
    });
    await expect(
      harness.dependencies.exclusivity.acquire("/synthetic/installation"),
    ).rejects.toMatchObject({
      code: "owner-busy",
    });
    resolveDrain("drained");
    await expect(run).resolves.toBe("done");
    const replacement = await harness.dependencies.exclusivity.acquire("/synthetic/installation");
    await replacement.release();
  });

  it("covers invalid maintenance deadlines, live drain expiry, and corrupt state", async () => {
    const invalid = dependencyHarness();
    await expect(
      createHostRuntime(invalid.dependencies).maintenance.run({ drainUntil: "invalid" }, () =>
        Promise.resolve(),
      ),
    ).rejects.toMatchObject({
      code: "drain-expired",
      message: "drain deadline is invalid or expired",
    });
    const invalidNow = dependencyHarness({ clock: { now: () => "invalid" } });
    await expect(
      createHostRuntime(invalidNow.dependencies).maintenance.run(
        { drainUntil: "2026-09-13T12:00:00.000Z" },
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: "drain-expired" });

    const past = dependencyHarness();
    const pastRuntime = createHostRuntime(past.dependencies);
    await pastRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      pastRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T11:59:59.999Z" }),
    ).resolves.toEqual({ state: "failed", reasonCode: "drain-expired" });
    expect(past.events).not.toContain("drain");

    const liveExpired = dependencyHarness({
      drain: {
        drain: vi.fn(() => Promise.resolve("expired" as const)),
        resume: vi.fn(() => undefined),
      },
    });
    const liveRuntime = createHostRuntime(liveExpired.dependencies);
    await liveRuntime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      liveRuntime.maintenance.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, () =>
        Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: "drain-expired", message: "drain deadline expired" });
    await liveRuntime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" });

    const corrupt = dependencyHarness({
      index: { inspect: vi.fn(() => Promise.resolve({ ...index, state: "corrupt" as const })) },
    });
    await expect(
      createHostRuntime(corrupt.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "index" });

    const uncertain = dependencyHarness({
      index: { inspect: vi.fn(() => Promise.resolve({ ...index, state: "uncertain" as const })) },
    });
    await expect(
      createHostRuntime(uncertain.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "index" });

    const exactIndexFailure = dependencyHarness({
      index: { inspect: vi.fn(() => Promise.resolve({ ...index, state: "uncertain" as const })) },
    });
    await expect(
      createHostRuntime(exactIndexFailure.dependencies).maintenance.preview(() =>
        Promise.resolve(),
      ),
    ).rejects.toThrow("operation index is not ready");
  });

  it("fails closed before standalone database opening and preserves lock failures", async () => {
    const pending = dependencyHarness({
      recovery: {
        inspect: vi.fn(() =>
          Promise.resolve({
            state: "prepared" as const,
            operationId: "op-1",
            checkpoint: null,
            reasonCode: "pending",
          }),
        ),
      },
    });
    await expect(
      createHostRuntime(pending.dependencies).maintenance.preview(() => Promise.resolve()),
    ).rejects.toMatchObject({ code: "uncertain", message: "recovery requires operator review" });
    expect(pending.events).not.toContain("storage.open:read-only");
    expect(pending.events).toContain("lock.release");

    const corruptPreview = dependencyHarness({
      index: { inspect: vi.fn(() => Promise.resolve({ ...index, state: "corrupt" as const })) },
    });
    await expect(
      createHostRuntime(corruptPreview.dependencies).maintenance.preview(() => Promise.resolve()),
    ).rejects.toMatchObject({ code: "corrupt", message: "operation index is not ready" });

    const pendingIndex = dependencyHarness({
      index: {
        inspect: vi.fn(() =>
          Promise.resolve({
            ...index,
            pendingCheckpoint: {
              operationId: "op-1" as never,
              authorityLineage: index.authorityLineage,
              expectedIndexGeneration: 1,
              nextIndexGeneration: 2,
              targetCount: 1,
              artifactDigest: index.databaseLineage,
              state: "prepared" as const,
              contentState: "pending" as const,
              durableIntent: "none" as const,
            },
          }),
        ),
      },
    });
    await expect(
      createHostRuntime(pendingIndex.dependencies).maintenance.preview(() => Promise.resolve()),
    ).rejects.toMatchObject({ code: "uncertain", message: "operation index is not ready" });

    const malformedIndex = dependencyHarness({
      index: { inspect: vi.fn(() => Promise.resolve({ malformed: true } as never)) },
    });
    await expect(
      createHostRuntime(malformedIndex.dependencies).maintenance.preview(() => Promise.resolve()),
    ).rejects.toMatchObject({
      code: "corrupt",
      message: "operation index cannot be validated",
    });

    const specialFailure = dependencyHarness({
      configuration: {
        read: vi.fn(() => Promise.resolve(validConfig)),
        validate: vi.fn((): Promise<void> =>
          Promise.reject(new HostError("host-live", "host is already live")),
        ),
      },
    });
    await expect(
      createHostRuntime(specialFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "recovery" });

    const lockFailure = dependencyHarness({
      exclusivity: {
        acquire: vi.fn((): Promise<never> => Promise.reject(new HostError("owner-busy", "held"))),
        inspect: vi.fn(() => Promise.resolve("free" as const)),
      },
    });
    await expect(
      createHostRuntime(lockFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });
  });

  it("validates standalone configuration before opening storage and preserves release reasons", async () => {
    const invalid = dependencyHarness({
      configuration: {
        read: vi.fn(() => Promise.resolve(validConfig)),
        validate: vi.fn(() =>
          Promise.reject(new HostError("stale-generation", "release mismatch")),
        ),
      },
    });
    const invalidRuntime = createHostRuntime(invalid.dependencies);
    await expect(invalidRuntime.maintenance.preview(() => Promise.resolve())).rejects.toMatchObject(
      {
        code: "stale-generation",
        message: "release mismatch",
      },
    );
    await expect(
      invalidRuntime.maintenance.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, () =>
        Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: "stale-generation" });
    expect(invalid.events).not.toContain("storage.open:read-only");
    expect(invalid.events).not.toContain("storage.open:read-write");
    expect(invalid.dependencies.configuration.read).toHaveBeenCalledWith({
      installationRoot: "/synthetic/installation",
    });
    expect(invalid.dependencies.configuration.validate).toHaveBeenCalledWith({
      installationRoot: "/synthetic/installation",
      config: validConfig,
      requestedReleaseId: "release-1",
    });

    for (const [code, reason] of [
      ...startupFailureCases,
      ["limit", "recovery"],
      ["host-live", "recovery"],
      ["drain-expired", "recovery"],
      ["unknown-target", "recovery"],
      ["blocked-reference", "recovery"],
      ["stale-preview", "recovery"],
      ["invalid-manifest", "recovery"],
    ] as const) {
      const harness = validationFailureHarness(code);
      await expectStartupFailure(harness.dependencies, reason);
    }
  });

  it("retains standalone ownership when setup cleanup cannot release", async () => {
    const harness = dependencyHarness({
      configuration: {
        read: vi.fn(() => Promise.resolve(validConfig)),
        validate: vi.fn(() => Promise.reject(new HostError("stale-generation", "mismatch"))),
      },
      exclusivity: {
        acquire: vi.fn(() =>
          Promise.resolve({
            canonicalRoot: "/synthetic/installation",
            release: vi.fn(() => Promise.reject(new Error("release uncertain"))),
          }),
        ),
        inspect: vi.fn(() => Promise.resolve("free" as const)),
      },
    });
    await expect(
      createHostRuntime(harness.dependencies).maintenance.preview(() => Promise.resolve()),
    ).rejects.toThrow("release uncertain");
  });

  it("fails closed when a retained standalone database still cannot close", async () => {
    const harness = dependencyHarness({
      storage: storageWithClose(() => Promise.reject(new Error("close uncertain"))),
    });
    const runtime = createHostRuntime(harness.dependencies);
    await expect(runtime.maintenance.preview(() => Promise.resolve())).rejects.toThrow(
      "close uncertain",
    );
    await expect(runtime.maintenance.preview(() => Promise.resolve())).rejects.toMatchObject({
      code: "not-ready",
      message: "host resources could not be cleaned up",
    });
  });
});
