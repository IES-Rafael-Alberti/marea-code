import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
vi.mock("./preview-skills.boundary.js", () => ({ installExampleSkill: vi.fn() }));
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({
  acquireInstallation: vi.fn(),
  readOperationsConfig: vi.fn(),
  readTeacherHostConfig: vi.fn(),
  createOperationsApplication: vi.fn(),
  release: vi.fn(),
  assertOwned: vi.fn(),
  createBackup: vi.fn(),
  close: vi.fn(),
  inspectSqliteSchemaVersion: vi.fn(),
}));
vi.mock("@marea/sqlite-storage", () => ports);
vi.mock("../../apps/teacher-server/src/platform/operator-cli/installation-lock.js", () => ports);
vi.mock("../../apps/teacher-server/src/platform/operations-cli/operations-config.js", () => ports);
vi.mock(
  "../../apps/teacher-server/src/platform/operations-cli/operations-application.js",
  () => ports,
);
vi.mock("../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js", () => ports);
import { UpdateRolledBackError } from "./preview-update-rolled-back.js";
import { installExampleSkill } from "./preview-skills.boundary.js";
import {
  activatePreviewServer,
  assertPreviewServerIdle,
  assertPreviewServerReady,
  recoverInterruptedPreviewUpdate,
  updateJournal,
} from "./preview-server-update.boundary.js";

let root: string;
beforeEach(() => {
  vi.resetAllMocks();
  root = realpathSync(mkdtempSync(join(tmpdir(), "marea-preview-update-")));
  for (const name of ["state", "config", "dashboard"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "dashboard/index.html"), "dashboard");
  ports.acquireInstallation.mockReturnValue({
    release: ports.release,
    capability: { assertOwned: ports.assertOwned },
  });
  ports.release.mockReturnValue(true);
  ports.readOperationsConfig.mockReturnValue({ databasePath: join(root, "marea.sqlite") });
  ports.readTeacherHostConfig.mockReturnValue({
    releaseId: "release:preview",
    dashboardDistPath: join(root, "dashboard"),
    providers: [{ secret: "kept-private" }],
  });
  ports.createOperationsApplication.mockReturnValue({
    createBackup: ports.createBackup,
    close: ports.close,
  });
  ports.createBackup.mockResolvedValue({ path: join(root, "backups/safety") });
  ports.inspectSqliteSchemaVersion.mockReturnValue(14);
});

it("checks exclusive access before downloading without migrating or backing up, and refuses uncertain release", async () => {
  await assertPreviewServerIdle(root);
  expect(ports.acquireInstallation).toHaveBeenCalledExactlyOnceWith(root);
  expect(ports.release).toHaveBeenCalledOnce();
  expect(ports.createBackup).not.toHaveBeenCalled();
  ports.release.mockReturnValue(false);
  await expect(assertPreviewServerIdle(root)).rejects.toThrow("installation-lost");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("backs up before activation without migrating, preserves settings and clears the journal only after validation", async () => {
  const writes = vi.spyOn(filesystem, "writeFileSync").mockClear();
  const activate = vi.fn(() => {
    expect(ports.close).toHaveBeenCalledOnce();
    expect(statSync(join(root, "state", updateJournal)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(root, "state", updateJournal), "utf8"))).toMatchObject({
      format: 2,
      version: "0.1.0-preview.2",
      schemaVersion: 14,
      previousActive: null,
      destinationExisted: false,
      backup: join(root, "backups/safety"),
    });
    return Promise.resolve("activated");
  });
  expect(
    await activatePreviewServer(root, "/programs/server-v2", "0.1.0-preview.2", activate),
  ).toBe("activated");
  expect(installExampleSkill).toHaveBeenCalledExactlyOnceWith(root, "/programs/server-v2");
  expect(vi.mocked(installExampleSkill).mock.invocationCallOrder[0]).toBeGreaterThan(
    activate.mock.invocationCallOrder[0] ?? 0,
  );
  expect(ports.createBackup).toHaveBeenCalledWith(expect.stringMatching(/^preview-/u));
  for (const call of writes.mock.calls) expect(call[2]).toEqual({ flag: "wx", mode: 0o600 });
  expect(ports.close).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(join(root, "config/teacher-host.json"), "utf8"))).toEqual({
    releaseId: "release:preview",
    dashboardDistPath: "/programs/server-v2/dashboard",
    providers: [{ secret: "kept-private" }],
    serverVersion: "0.1.0-preview.2",
  });
  expect(existsSync(join(root, "state", updateJournal))).toBe(false);
  expect(ports.readTeacherHostConfig).toHaveBeenCalledTimes(2);
  expect(ports.release).toHaveBeenCalledOnce();
  expect(ports.assertOwned).toHaveBeenCalledTimes(2);
  expect(updateJournal).toBe("preview-update-pending.json");
  expect(statSync(join(root, "config/teacher-host.json")).mode & 0o777).toBe(0o600);
  const clock = ports.createOperationsApplication.mock.calls[0]?.[2] as () => string;
  expect(Date.parse(clock())).toBeGreaterThan(0);
  expect(assertPreviewServerReady(root)).toBe("release:preview");
  writeFileSync(join(root, "dashboard/index.html"), "");
  expect(() => assertPreviewServerReady(root)).toThrow("Dashboard is missing");
});

it("refuses live owners, keeps interrupted updates blocked, and never activates after a backup failure", async () => {
  const activate = vi.fn(() => Promise.resolve());
  ports.acquireInstallation.mockImplementationOnce(() => {
    throw new Error("busy");
  });
  await expect(activatePreviewServer(root, "new", "v2", activate)).rejects.toThrow("busy");
  expect(ports.createBackup).not.toHaveBeenCalled();
  ports.createBackup.mockRejectedValueOnce(new Error("disk full"));
  await expect(activatePreviewServer(root, "new", "v2", activate)).rejects.toThrow("disk full");
  expect(activate).not.toHaveBeenCalled();
  expect(existsSync(join(root, "state", updateJournal))).toBe(false);
  expect(ports.close).toHaveBeenCalledOnce();
  await expect(
    activatePreviewServer(root, "new", "v2", () => {
      // The new binary ran and migrated before the update was interrupted.
      ports.inspectSqliteSchemaVersion.mockReturnValue(15);
      return Promise.reject(new Error("activation interrupted"));
    }),
  ).rejects.toThrow("activation interrupted");
  expect(existsSync(join(root, "state", updateJournal))).toBe(true);
  expect(() => assertPreviewServerReady(root)).toThrow("interrupted update");
  await expect(activatePreviewServer(root, "new", "v2", activate)).rejects.toThrow(
    "Previous update needs recovery",
  );
  expect(activate).not.toHaveBeenCalled();
  expect(ports.release).toHaveBeenCalledTimes(3);
});

describe("rollback of a failed update", () => {
  const previousHost = {
    releaseId: "release:preview",
    dashboardDistPath: "",
    serverVersion: "0.1.0-preview.1",
    providers: [{ secret: "kept-private" }],
  };
  const previousPointer = JSON.stringify({ current: "server-0.1.0-preview.1", previous: null });
  let programs: string;
  let destination: string;
  const journalPath = () => join(root, "state", updateJournal);
  const pointerPath = () => join(programs, "active.json");
  const hostPath = () => join(root, "config", "teacher-host.json");

  /** What installRelease does: publish the program directory, then swap the pointer. */
  function activateNewRelease(): Promise<string> {
    mkdirSync(join(destination, "dashboard"), { recursive: true });
    writeFileSync(pointerPath(), JSON.stringify({ current: "server-0.1.0-preview.2" }));
    return Promise.resolve("activated");
  }

  beforeEach(() => {
    programs = join(root, "programs");
    destination = join(programs, "server-0.1.0-preview.2");
    mkdirSync(programs);
    writeFileSync(pointerPath(), previousPointer);
    const host = { ...previousHost, dashboardDistPath: join(root, "dashboard") };
    writeFileSync(hostPath(), JSON.stringify(host));
    ports.readTeacherHostConfig.mockImplementation(
      () => JSON.parse(readFileSync(hostPath(), "utf8")) as Record<string, unknown>,
    );
  });

  function expectPreviousReleaseRestored(): void {
    expect(readFileSync(pointerPath(), "utf8")).toBe(previousPointer);
    expect(JSON.parse(readFileSync(hostPath(), "utf8")) as Record<string, unknown>).toMatchObject({
      serverVersion: "0.1.0-preview.1",
      dashboardDistPath: join(root, "dashboard"),
      providers: [{ secret: "kept-private" }],
    });
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(journalPath())).toBe(false);
    expect(assertPreviewServerReady(root)).toBe("release:preview");
  }

  it("returns to the previous release when activation throws after the pointer changed", async () => {
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", () => {
        void activateNewRelease();
        return Promise.reject(new Error("EPERM: rename active.json"));
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        name: "UpdateRolledBackError",
        message: "EPERM: rename active.json",
      }),
    );
    expectPreviousReleaseRestored();
    expect(ports.release).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "the example skill cannot be installed",
      () => {
        vi.mocked(installExampleSkill).mockImplementationOnce(() => {
          throw new Error("skill copy failed");
        });
      },
      "skill copy failed",
    ],
    [
      "the new configuration does not validate",
      () => {
        ports.readTeacherHostConfig.mockImplementationOnce(
          () => JSON.parse(readFileSync(hostPath(), "utf8")) as Record<string, unknown>,
        );
        ports.readTeacherHostConfig.mockImplementationOnce(() => {
          throw new Error("host config invalid");
        });
      },
      "host config invalid",
    ],
    [
      "ownership is lost after the swap",
      () => {
        ports.assertOwned
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw new Error("installation-lost");
          });
      },
      "installation-lost",
    ],
  ])("restores the pointer and host settings when %s", async (_name, arrange, failure) => {
    arrange();
    const attempt = activatePreviewServer(root, destination, "0.1.0-preview.2", activateNewRelease);
    await expect(attempt).rejects.toBeInstanceOf(UpdateRolledBackError);
    await expect(attempt).rejects.toThrow(failure);
    expectPreviousReleaseRestored();
  });

  it("lets a retried update succeed after the rollback", async () => {
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", async () => {
        await activateNewRelease();
        throw new Error("first attempt failed");
      }),
    ).rejects.toBeInstanceOf(UpdateRolledBackError);
    expect(existsSync(destination)).toBe(false);

    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", activateNewRelease),
    ).resolves.toBe("activated");

    expect(JSON.parse(readFileSync(hostPath(), "utf8")) as Record<string, unknown>).toMatchObject({
      serverVersion: "0.1.0-preview.2",
    });
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(journalPath())).toBe(false);
  });

  it("removes the activation pointer when the update created the first one", async () => {
    rmSync(pointerPath());
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", async () => {
        await activateNewRelease();
        throw new Error("failed");
      }),
    ).rejects.toBeInstanceOf(UpdateRolledBackError);
    expect(existsSync(pointerPath())).toBe(false);
    expect(existsSync(journalPath())).toBe(false);
  });

  it("keeps a program directory that existed before the update", async () => {
    mkdirSync(destination);
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", () =>
        Promise.reject(new Error("failed")),
      ),
    ).rejects.toBeInstanceOf(UpdateRolledBackError);
    expect(existsSync(destination)).toBe(true);
  });

  it("restores files privately and asks the database about the configured path", async () => {
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", async () => {
        await activateNewRelease();
        throw new Error("failed");
      }),
    ).rejects.toBeInstanceOf(UpdateRolledBackError);
    expect(ports.inspectSqliteSchemaVersion).toHaveBeenCalledWith({
      databasePath: join(root, "marea.sqlite"),
    });
    expect(statSync(pointerPath()).mode & 0o777).toBe(0o600);
    expect(statSync(hostPath()).mode & 0o777).toBe(0o600);
  });

  it("reports a failure that is not an Error object by its text", async () => {
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", () =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject("disk vanished"),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ name: "UpdateRolledBackError", message: "disk vanished" }),
    );
    expect(existsSync(journalPath())).toBe(false);
  });

  it("rolls back an activation that failed before it changed anything", async () => {
    rmSync(pointerPath());
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", () =>
        Promise.reject(new Error("EPERM")),
      ),
    ).rejects.toBeInstanceOf(UpdateRolledBackError);
    expect(existsSync(pointerPath())).toBe(false);
    expect(existsSync(journalPath())).toBe(false);
    expect(existsSync(destination)).toBe(false);
  });

  it("removes only complete server release names", async () => {
    for (const name of ["student-0.1.0-preview.2", "student-server-0.1.0", "server-0.1.0_x"]) {
      const other = join(programs, name);
      await expect(
        activatePreviewServer(root, other, "0.1.0-preview.2", () => {
          mkdirSync(other);
          return Promise.reject(new Error("failed"));
        }),
      ).rejects.toBeInstanceOf(UpdateRolledBackError);
      expect(existsSync(other)).toBe(true);
    }
  });

  it("keeps the journal and the original error when the restored files do not validate", async () => {
    ports.readTeacherHostConfig
      .mockImplementationOnce(() => JSON.parse(readFileSync(hostPath(), "utf8")) as object)
      .mockImplementationOnce(() => {
        throw new Error("restored config invalid");
      });
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", () =>
        Promise.reject(new Error("original failure")),
      ),
    ).rejects.toThrow(expect.objectContaining({ name: "Error", message: "original failure" }));
    expect(existsSync(journalPath())).toBe(true);
  });

  it("leaves everything for the manual restore when the database changed", async () => {
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", async () => {
        await activateNewRelease();
        ports.inspectSqliteSchemaVersion.mockReturnValue(15);
        throw new Error("failed after migration");
      }),
    ).rejects.toThrow(
      expect.objectContaining({ name: "Error", message: "failed after migration" }),
    );
    expect(existsSync(journalPath())).toBe(true);
    expect(readFileSync(pointerPath(), "utf8")).toContain("0.1.0-preview.2");
    expect(existsSync(destination)).toBe(true);
    expect(() => assertPreviewServerReady(root)).toThrow("interrupted update");
  });

  it("leaves the journal when the schema cannot be inspected or the rollback itself fails", async () => {
    await expect(
      activatePreviewServer(root, destination, "0.1.0-preview.2", () => {
        ports.inspectSqliteSchemaVersion.mockImplementation(() => {
          throw new Error("database-unavailable");
        });
        return Promise.reject(new Error("failed"));
      }),
    ).rejects.toThrow(expect.objectContaining({ name: "Error", message: "failed" }));
    expect(existsSync(journalPath())).toBe(true);
  });

  it("recovers at launch from a journal whose process died, then allows a retry", () => {
    writeFileSync(
      journalPath(),
      JSON.stringify({
        format: 2,
        version: "0.1.0-preview.2",
        destination,
        backup: join(root, "backups/safety"),
        previousHost: { ...previousHost, dashboardDistPath: join(root, "dashboard") },
        schemaVersion: 14,
        previousActive: previousPointer,
        destinationExisted: false,
      }),
    );
    mkdirSync(destination);
    writeFileSync(pointerPath(), JSON.stringify({ current: "server-0.1.0-preview.2" }));

    expect(recoverInterruptedPreviewUpdate(root)).toBe(true);

    expectPreviousReleaseRestored();
    expect(ports.acquireInstallation).toHaveBeenCalledExactlyOnceWith(root);
    expect(ports.release).toHaveBeenCalledOnce();
  });

  it("does not touch the installation without a journal, and refuses what it cannot prove", () => {
    expect(recoverInterruptedPreviewUpdate(root)).toBeUndefined();
    expect(ports.acquireInstallation).not.toHaveBeenCalled();

    for (const content of [
      JSON.stringify({ format: 1, version: "v", destination, backup: "b", previousHost: {} }),
      "not json",
    ]) {
      writeFileSync(journalPath(), content);
      expect(recoverInterruptedPreviewUpdate(root)).toBe(false);
      expect(readFileSync(journalPath(), "utf8")).toBe(content);
      rmSync(journalPath());
    }
    expect(ports.release).toHaveBeenCalledTimes(2);
  });

  it("releases the installation when the lock is busy", () => {
    writeFileSync(journalPath(), "{}");
    ports.acquireInstallation.mockImplementationOnce(() => {
      throw new Error("installation-busy");
    });
    expect(() => recoverInterruptedPreviewUpdate(root)).toThrow("installation-busy");
  });
});
