import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  terminal: { interactive: true, write: vi.fn(), readLine: vi.fn() },
  processExists: vi.fn(),
}));
vi.mock(
  "../../apps/teacher-server/src/platform/installation/lock-recovery-terminal.boundary.js",
  () => ({ processLockRecovery: () => ports }),
);

vi.mock(
  "bun:sqlite",
  () => import("../../apps/teacher-server/src/platform/operator-cli/bun-sqlite.fixture.js"),
);
import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.js";
import {
  cleanupTeacherHostInstallations,
  teacherHostInstallation,
} from "../../apps/teacher-server/src/platform/teacher-host/teacher-host.fixture.js";
import {
  activatePreviewServer,
  assertPreviewServerIdle,
} from "./preview-server-update.boundary.js";

beforeEach(() => {
  vi.resetAllMocks();
  ports.terminal.interactive = true;
  ports.terminal.readLine.mockResolvedValue("n");
  ports.processExists.mockReturnValue(false);
});
afterEach(cleanupTeacherHostInstallations);

it("refuses an actual held lock before download and rechecks ownership when activation starts", async () => {
  const f = teacherHostInstallation();
  const database = readFileSync(f.databasePath);
  const host = readFileSync(join(f.root, "config/teacher-host.json"));
  const lock = join(f.root, "locks/installation.lock");
  const activate = vi.fn(() => Promise.resolve());
  await assertPreviewServerIdle(f.root);
  const owner = acquireInstallation(f.root);
  ports.processExists.mockReturnValue(true);
  const record = readFileSync(lock);
  try {
    await expect(assertPreviewServerIdle(f.root)).rejects.toThrow("installation-busy");
    expect(ports.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining(
        `Warning: Marea appears to be running (process ${String(process.pid)})`,
      ),
    );
    await expect(
      activatePreviewServer(f.root, "/unused", "0.1.0-preview.31", activate),
    ).rejects.toThrow("installation-busy");
    expect(activate).not.toHaveBeenCalled();
    expect(readFileSync(lock)).toEqual(record);
    expect(readFileSync(f.databasePath)).toEqual(database);
    expect(readFileSync(join(f.root, "config/teacher-host.json"))).toEqual(host);
    expect(readdirSync(join(f.root, "backups"))).toEqual([]);
  } finally {
    owner.release();
  }
  await assertPreviewServerIdle(f.root);
  expect(readdirSync(join(f.root, "locks"))).toEqual([]);
});

function abandonedInstallation() {
  const f = teacherHostInstallation();
  const locks = [join(f.root, ".marea-installation.lock"), join(f.root, "locks/installation.lock")];
  for (const path of locks) writeFileSync(path, '{"pid":4242}', { mode: 0o600 });
  const before = readFileSync(f.databasePath);
  const config = readFileSync(join(f.root, "config/teacher-host.json"));
  return {
    ...f,
    locks,
    expectNoUpdate() {
      expect(readFileSync(f.databasePath)).toEqual(before);
      expect(readFileSync(join(f.root, "config/teacher-host.json"))).toEqual(config);
      expect(readdirSync(join(f.root, "backups"))).toEqual([]);
      expect(existsSync(join(f.root, "state/preview-update-pending.json"))).toBe(false);
    },
  };
}

it("recovers abandoned host and operator locks before downloading without starting the server", async () => {
  const f = abandonedInstallation();
  ports.terminal.readLine.mockResolvedValue("y");
  await assertPreviewServerIdle(f.root);
  expect(ports.terminal.readLine).toHaveBeenCalledOnce();
  expect(ports.processExists).toHaveBeenCalledWith(4242);
  expect(ports.terminal.write).toHaveBeenCalledWith("The lock was removed.\n");
  expect(f.locks.some((path) => existsSync(path))).toBe(false);
  f.expectNoUpdate();
  const owner = acquireInstallation(f.root);
  expect(owner.release()).toBe(true);
});

it.each(["n", "", undefined])(
  "keeps locks and data when recovery is not confirmed: %s",
  async (answer) => {
    const f = abandonedInstallation();
    ports.terminal.readLine.mockResolvedValue(answer);
    await expect(assertPreviewServerIdle(f.root)).rejects.toThrow("installation-busy");
    for (const path of f.locks) expect(readFileSync(path, "utf8")).toBe('{"pid":4242}');
    expect(ports.terminal.readLine).toHaveBeenCalledOnce();
    f.expectNoUpdate();
  },
);

it("does not recover locks without an interactive terminal", async () => {
  const f = abandonedInstallation();
  ports.terminal.interactive = false;
  await expect(assertPreviewServerIdle(f.root)).rejects.toThrow("installation-busy");
  expect(ports.terminal.readLine).not.toHaveBeenCalled();
  expect(f.locks.every((path) => existsSync(path))).toBe(true);
  f.expectNoUpdate();
});

it("does not continue if the lock changes while the teacher answers", async () => {
  const f = abandonedInstallation();
  const lock = join(f.root, "locks/installation.lock");
  ports.terminal.readLine.mockImplementation(() => {
    writeFileSync(lock, '{"pid":4243}');
    return Promise.resolve("y");
  });
  await expect(assertPreviewServerIdle(f.root)).rejects.toThrow("installation-busy");
  expect(ports.terminal.write).toHaveBeenCalledWith(
    "The lock changed while waiting; nothing was removed.\n",
  );
  expect(readFileSync(lock, "utf8")).toBe('{"pid":4243}');
  expect(f.locks.every((path) => existsSync(path))).toBe(true);
  f.expectNoUpdate();
});
