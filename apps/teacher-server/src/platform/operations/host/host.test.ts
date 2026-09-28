/* eslint-disable max-lines, @typescript-eslint/unbound-method */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MaintenancePreviewView, RecoveryInspection } from "../contracts.js";
import {
  FilesystemInstallationExclusivity,
  HostOperationError,
  HostRuntimeController,
  createHostLifecycle,
  createMaintenanceCoordinator,
  createHostRuntime,
  filesystemInstallationExclusivity,
} from "./index.js";
import {
  config,
  dependencyHarness,
  expectStartupFailure,
  hostPortsAreInjected,
} from "./host-test-fixtures.fixture.js";

describe("FilesystemInstallationExclusivity", () => {
  it("keeps a real lock until its owner releases it and rejects aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const alias = `${root}-alias`;
    await symlink(root, alias);
    const exclusivity = new FilesystemInstallationExclusivity();
    const lock = await exclusivity.acquire(root);
    await expect(exclusivity.acquire(root)).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation is already owned",
    });
    const child = spawnSync(
      "bun",
      [
        "-e",
        `import(${JSON.stringify(new URL("./filesystem-exclusivity.ts", import.meta.url).href)}).then(async ({ FilesystemInstallationExclusivity }) => { try { await new FilesystemInstallationExclusivity().acquire(${JSON.stringify(root)}); process.stdout.write("unexpected"); } catch (error) { process.stdout.write(error.code); } })`,
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("owner-busy");
    await expect(exclusivity.acquire(alias)).rejects.toMatchObject({
      code: "path",
      message: "installation root is not a directory",
    });
    expect(await exclusivity.inspect(root)).toBe("held");
    await lock.release();
    await lock.release();
    expect(await exclusivity.inspect(root)).toBe("free");
  });

  it("does not steal an invalid or symlink lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const target = await mkdtemp(join(tmpdir(), "marea-host-target-"));
    await symlink(target, join(root, ".marea-installation.lock"));
    const exclusivity = new FilesystemInstallationExclusivity();
    await expect(exclusivity.acquire(root)).rejects.toMatchObject({
      code: "path",
      message: "installation lock is a symbolic link",
    });
    expect(await exclusivity.inspect(root)).toBe("unknown");
  });

  it("rejects noncanonical, non-directory, and malformed lock roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const file = join(root, "not-a-root");
    await writeFile(file, "file");
    const exclusivity = new FilesystemInstallationExclusivity();
    await expect(exclusivity.acquire("relative-root")).rejects.toMatchObject({
      code: "path",
      message: "installation root must be absolute",
    });
    await expect(exclusivity.acquire(file)).rejects.toMatchObject({
      code: "path",
      message: "installation root is not a directory",
    });
    await expect(exclusivity.inspect(join(root, "missing"))).rejects.toMatchObject({
      code: "path",
      message: "installation root is unavailable",
    });
    await mkdir(join(root, ".marea-installation.lock"));
    expect(await exclusivity.inspect(root)).toBe("unknown");
    await expect(exclusivity.acquire(root)).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation is already owned",
    });
  });

  it("refuses release after lock contents or identity are replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const path = join(root, ".marea-installation.lock");
    const exclusivity = new FilesystemInstallationExclusivity();
    const malformed = await exclusivity.acquire(root);
    const malformedRecord = await readFile(path);
    const malformedHandle = (malformed as unknown as { handle: { close: () => Promise<void> } })
      .handle;
    const malformedClose = malformedHandle.close;
    let malformedCloseAttempts = 0;
    malformedHandle.close = vi.fn(() => {
      malformedCloseAttempts += 1;
      return malformedCloseAttempts === 1
        ? Promise.reject(new Error("close uncertain"))
        : malformedClose();
    });
    await writeFile(path, "not-json");
    await expect(malformed.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock JSON is invalid",
    });
    expect(malformedHandle.close).not.toHaveBeenCalled();
    expect(malformed.releaseState).toBe("owned");
    await writeFile(path, malformedRecord);
    await expect(malformed.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock could not be released",
    });
    expect(malformed.releaseState).toBe("owned");
    await expect(malformed.release()).resolves.toBeUndefined();
    expect(malformedHandle.close).toHaveBeenCalledTimes(2);
    expect(malformed.releaseState).toBe("released");
    await expect(exclusivity.inspect(root)).resolves.toBe("free");
    const replaced = await exclusivity.acquire(root);
    await rm(path);
    await writeFile(path, "replacement");
    await expect(replaced.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock ownership changed",
    });
    await rm(path);
  });
});

describe("host lifecycle and maintenance", () => {
  it("exposes separate lifecycle and maintenance factories over the same ports", () => {
    const harness = dependencyHarness();
    expect(hostPortsAreInjected).toBeNull();
    expect(new HostOperationError("path", "detail")).toMatchObject({
      name: "HostOperationError",
      code: "path",
      message: "detail",
    });
    expect(createHostLifecycle(harness.dependencies)).toHaveProperty("start");
    expect(createMaintenanceCoordinator(harness.dependencies)).toHaveProperty("preview");
    expect(new HostRuntimeController(harness.dependencies)).toBeInstanceOf(HostRuntimeController);
    expect(filesystemInstallationExclusivity).toBeInstanceOf(FilesystemInstallationExclusivity);
  });

  it("shares lifecycle state and serialization across the separate factories", async () => {
    const harness = dependencyHarness();
    const lifecycle = createHostLifecycle(harness.dependencies);
    const maintenance = createMaintenanceCoordinator(harness.dependencies);
    await expect(
      lifecycle.start({ installationRoot: "/synthetic/installation", releaseId: "release-1" }),
    ).resolves.toMatchObject({ state: "ready" });
    await expect(
      maintenance.preview((view) => Promise.resolve(view.database.readAll("SELECT 1"))),
    ).resolves.toEqual([]);
    expect(harness.events.filter((event) => event === "lock.acquire")).toHaveLength(1);
    expect(harness.events.filter((event) => event === "storage.open:read-only")).toHaveLength(0);
    await lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" });
  });

  it("locks before every state/database open and gives preview no write port", async () => {
    const harness = dependencyHarness();
    const runtime = createHostRuntime(harness.dependencies);
    await expect(
      runtime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({
      state: "ready",
      releaseId: "release-1",
      schemaVersion: 8,
    });
    expect(harness.statusRecords).toEqual([
      {
        status: "starting",
        releaseId: "release-1",
        schemaVersion: 8,
        reasonCode: "starting",
        observedAt: "2026-09-13T12:00:00.000Z",
      },
      {
        status: "ready",
        releaseId: "release-1",
        schemaVersion: 8,
        reasonCode: "ready",
        observedAt: "2026-09-13T12:00:00.000Z",
      },
    ]);
    expect(harness.dependencies.configuration.read).toHaveBeenCalledWith({
      installationRoot: "/synthetic/installation",
      requestedReleaseId: "release-1",
    });
    expect(harness.dependencies.configuration.validate).toHaveBeenCalledWith({
      installationRoot: "/synthetic/installation",
      config,
      requestedReleaseId: "release-1",
    });
    expect(harness.events.indexOf("lock.acquire")).toBeLessThan(
      harness.events.indexOf("config.read"),
    );
    expect(harness.events.indexOf("config.read")).toBeLessThan(
      harness.events.indexOf("storage.open:read-write"),
    );
    await runtime.maintenance.preview((view: MaintenancePreviewView) => {
      expect(view.database).not.toHaveProperty("execute");
      expect(view.database.readAll("SELECT 1")).toEqual([]);
      return Promise.resolve("previewed");
    });
    expect(harness.executeCount).toBe(0);
    await runtime.maintenance.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, (view) => {
      view.database.execute("UPDATE synthetic SET value = 1");
      return Promise.resolve("ran");
    });
    expect(harness.executeCount).toBe(1);
    await expect(
      runtime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toMatchObject({ state: "stopped" });
    expect(harness.statusRecords.at(-1)).toEqual({
      status: "stopped",
      releaseId: "release-1",
      schemaVersion: 8,
      reasonCode: "stopped",
      observedAt: "2026-09-13T12:00:00.000Z",
    });
    expect(harness.statusRecords.at(-2)).toEqual({
      status: "draining",
      releaseId: "release-1",
      schemaVersion: 8,
      reasonCode: "shutdown",
      observedAt: "2026-09-13T12:00:00.000Z",
    });
    expect(harness.events).toContain("resume");
    expect(harness.events.indexOf("database.close")).toBeLessThan(
      harness.events.indexOf("lock.release"),
    );
  });

  it("closes and releases after failed startup and blocks pending recovery", async () => {
    const failure = dependencyHarness({
      storage: {
        open: vi.fn(() => Promise.reject(new Error("open failed"))),
      },
    });
    const failedRuntime = createHostRuntime(failure.dependencies);
    await expect(
      failedRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "storage" });
    expect(failure.events).toContain("lock.release");
    const pending = dependencyHarness({
      recovery: {
        inspect: vi.fn((): Promise<RecoveryInspection> =>
          Promise.resolve({
            state: "prepared",
            operationId: "op-1",
            checkpoint: null,
            reasonCode: "pending",
          }),
        ),
      },
    });
    const pendingRuntime = createHostRuntime(pending.dependencies);
    await expect(
      pendingRuntime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "index" });
    expect(pending.events).not.toContain("storage.open:read-write");
  });

  it("diagnoses without opening storage", async () => {
    const harness = dependencyHarness();
    const runtime = createHostRuntime(harness.dependencies);
    await expect(
      runtime.lifecycle.offlineDiagnose({ installationRoot: "/synthetic/installation" }),
    ).resolves.toEqual({
      mode: "offline-validation",
      observedAt: "2026-09-13T12:00:00.000Z",
      status: "unknown",
      releaseId: "release-1",
      schemaVersion: 8,
      checks: ["lock-free", "config-valid", "index-valid"],
      reasonCode: "diagnosed",
    });
    expect(harness.events).not.toContain("storage.open:read-write");
  });

  it("keeps lifecycle calls idempotent and reports deadline/drain outcomes", async () => {
    const harness = dependencyHarness();
    const runtime = createHostRuntime(harness.dependencies);
    await runtime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      runtime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toMatchObject({ state: "ready" });
    await expect(
      runtime.lifecycle.start({ installationRoot: "/other", releaseId: "release-1" }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });
    await expect(
      runtime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-2",
      }),
    ).resolves.toEqual({ state: "failed", reason: "lock" });
    await expect(runtime.lifecycle.shutdown({ drainUntil: "invalid" })).resolves.toEqual({
      state: "failed",
      reasonCode: "drain-expired",
    });
    await expect(
      runtime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" }),
    ).resolves.toEqual({ state: "stopped", reasonCode: "not-running" });
    await expect(
      runtime.lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "ready", releaseId: "release-1", schemaVersion: 8 });
    await runtime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" });
  });

  it("maps configuration, recovery, index, status, and storage startup failures", async () => {
    const configFailure = dependencyHarness({
      configuration: {
        read: vi.fn(() => Promise.reject(new Error("bad config"))),
        validate: vi.fn(() => Promise.resolve()),
      },
    });
    await expectStartupFailure(configFailure.dependencies, "config");

    const recoveryFailure = dependencyHarness({
      recovery: { inspect: vi.fn(() => Promise.reject(new Error("recovery unavailable"))) },
    });
    await expect(
      createHostRuntime(recoveryFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "recovery" });

    const codedNonHostFailure = dependencyHarness({
      recovery: {
        inspect: vi.fn(() =>
          Promise.reject(Object.assign(new Error("coded recovery"), { code: "not-ready" })),
        ),
      },
    });
    await expect(
      createHostRuntime(codedNonHostFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "recovery" });

    const corruptIndex = dependencyHarness({
      index: { inspect: vi.fn(() => Promise.resolve({ corrupt: true } as never)) },
    });
    await expect(
      createHostRuntime(corruptIndex.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "index" });

    const statusFailure = dependencyHarness({
      status: {
        read: vi.fn(() => Promise.resolve(null)),
        write: vi.fn(() => Promise.reject(new Error("status unavailable"))),
      },
    });
    await expect(
      createHostRuntime(statusFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "recovery" });

    const storageFailure = dependencyHarness({
      storage: { open: vi.fn(() => Promise.reject(new Error("storage unavailable"))) },
    });
    await expect(
      createHostRuntime(storageFailure.dependencies).lifecycle.start({
        installationRoot: "/synthetic/installation",
        releaseId: "release-1",
      }),
    ).resolves.toEqual({ state: "failed", reason: "storage" });
  });

  it("handles standalone preview/run and always resumes and cleans up", async () => {
    const preview = dependencyHarness();
    const previewRuntime = createHostRuntime(preview.dependencies);
    await expect(
      previewRuntime.maintenance.preview((view) =>
        Promise.resolve(view.database.readOne("SELECT 1")),
      ),
    ).resolves.toBeUndefined();
    expect(preview.events).toEqual(
      expect.arrayContaining([
        "lock.acquire",
        "storage.open:read-only",
        "database.close",
        "lock.release",
      ]),
    );

    const run = dependencyHarness();
    const runRuntime = createHostRuntime(run.dependencies);
    await expect(
      runRuntime.maintenance.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, (view) => {
        view.database.execute("UPDATE synthetic SET value = 2");
        return Promise.resolve("done");
      }),
    ).resolves.toBe("done");
    expect(run.events).toEqual(
      expect.arrayContaining(["storage.open:read-write", "drain", "resume"]),
    );

    const expired = dependencyHarness({
      drain: {
        drain: vi.fn(() => Promise.resolve("expired" as const)),
        resume: vi.fn(() => undefined),
      },
    });
    await expect(
      createHostRuntime(expired.dependencies).maintenance.run(
        { drainUntil: "2026-09-13T12:00:00.000Z" },
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: "drain-expired", message: "drain deadline expired" });
    expect(expired.events).toContain("storage.open:read-write");

    const failedPreview = dependencyHarness();
    await expect(
      createHostRuntime(failedPreview.dependencies).maintenance.preview(() =>
        Promise.reject(new Error("preview failed")),
      ),
    ).rejects.toThrow("preview failed");
    await expect(
      createHostRuntime(failedPreview.dependencies).maintenance.preview(
        // Exercise normalization of an untyped dependency failure.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/no-confusing-void-expression
        () => new Promise((_, reject) => reject("preview failed generically")),
      ),
    ).rejects.toThrow("unknown host failure");
    expect(failedPreview.events.indexOf("database.close")).toBeLessThan(
      failedPreview.events.indexOf("lock.release"),
    );

    const failedRun = dependencyHarness();
    await expect(
      createHostRuntime(failedRun.dependencies).maintenance.run(
        { drainUntil: "2026-09-13T12:00:00.000Z" },
        () => Promise.reject(new Error("run failed")),
      ),
    ).rejects.toThrow("run failed");
    expect(failedRun.events.indexOf("resume")).toBeLessThan(
      failedRun.events.indexOf("database.close"),
    );
    expect(failedRun.events.indexOf("database.close")).toBeLessThan(
      failedRun.events.indexOf("lock.release"),
    );
  });

  it("rejects invalid graph/setup and preserves serialization on operation errors", async () => {
    const noGraph = new HostRuntimeController({
      ...dependencyHarness().dependencies,
      graph: undefined,
    } as never);
    await expect(noGraph.preview(() => Promise.resolve())).rejects.toMatchObject({
      code: "not-ready",
      message: "maintenance reference graph is unavailable",
    });
    await expect(
      noGraph.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, () => Promise.resolve()),
    ).rejects.toMatchObject({
      code: "not-ready",
      message: "maintenance reference graph is unavailable",
    });
    const operationFailure = dependencyHarness();
    const runtime = createHostRuntime(operationFailure.dependencies);
    await runtime.lifecycle.start({
      installationRoot: "/synthetic/installation",
      releaseId: "release-1",
    });
    await expect(
      runtime.maintenance.run({ drainUntil: "2026-09-13T12:00:00.000Z" }, () =>
        Promise.reject(new Error("operation failed")),
      ),
    ).rejects.toThrow("operation failed");
    expect(operationFailure.events).toContain("resume");
    await runtime.lifecycle.shutdown({ drainUntil: "2026-09-13T12:00:00.000Z" });
  });
});
