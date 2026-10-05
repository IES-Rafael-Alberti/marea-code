import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({
  acquireInstallation: vi.fn(),
  readOperationsConfig: vi.fn(),
  readTeacherHostConfig: vi.fn(),
  createOperationsApplication: vi.fn(),
  initializeSqliteStorage: vi.fn(),
  release: vi.fn(),
  assertOwned: vi.fn(),
  createBackup: vi.fn(),
  close: vi.fn(),
  closeStorage: vi.fn(),
}));
vi.mock("@marea/sqlite-storage", () => ports);
vi.mock("../../apps/teacher-server/src/platform/operator-cli/installation-lock.js", () => ports);
vi.mock("../../apps/teacher-server/src/platform/operations-cli/operations-config.js", () => ports);
vi.mock(
  "../../apps/teacher-server/src/platform/operations-cli/operations-application.js",
  () => ports,
);
vi.mock("../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js", () => ports);
import {
  activatePreviewServer,
  assertPreviewServerReady,
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
  ports.initializeSqliteStorage.mockReturnValue({ close: ports.closeStorage });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("backs up before migration and activation, preserves settings and clears the journal only after validation", async () => {
  const writes = vi.spyOn(filesystem, "writeFileSync").mockClear();
  const activate = vi.fn(() => {
    expect(ports.closeStorage).toHaveBeenCalledOnce();
    expect(statSync(join(root, "state", updateJournal)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(root, "state", updateJournal), "utf8"))).toMatchObject({
      format: 1,
      version: "0.1.0-preview.2",
      backup: join(root, "backups/safety"),
    });
    return Promise.resolve("activated");
  });
  expect(
    await activatePreviewServer(root, "/programs/server-v2", "0.1.0-preview.2", activate),
  ).toBe("activated");
  expect(ports.createBackup).toHaveBeenCalledWith(expect.stringMatching(/^preview-/u));
  for (const call of writes.mock.calls) expect(call[2]).toEqual({ flag: "wx", mode: 0o600 });
  expect(ports.close).toHaveBeenCalledOnce();
  expect(ports.initializeSqliteStorage).toHaveBeenCalledWith({
    databasePath: join(root, "marea.sqlite"),
    schema: "student-identities",
  });
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

it("refuses live owners, keeps interrupted updates blocked, and never migrates after a backup failure", async () => {
  const activate = vi.fn(() => Promise.resolve());
  ports.acquireInstallation.mockImplementationOnce(() => {
    throw new Error("busy");
  });
  await expect(activatePreviewServer(root, "new", "v2", activate)).rejects.toThrow("busy");
  expect(ports.createBackup).not.toHaveBeenCalled();
  ports.createBackup.mockRejectedValueOnce(new Error("disk full"));
  await expect(activatePreviewServer(root, "new", "v2", activate)).rejects.toThrow("disk full");
  expect(ports.initializeSqliteStorage).not.toHaveBeenCalled();
  expect(existsSync(join(root, "state", updateJournal))).toBe(false);
  expect(ports.close).toHaveBeenCalledOnce();
  await expect(
    activatePreviewServer(root, "new", "v2", () =>
      Promise.reject(new Error("activation interrupted")),
    ),
  ).rejects.toThrow("activation interrupted");
  expect(existsSync(join(root, "state", updateJournal))).toBe(true);
  expect(() => assertPreviewServerReady(root)).toThrow("interrupted update");
  await expect(activatePreviewServer(root, "new", "v2", activate)).rejects.toThrow(
    "Previous update needs recovery",
  );
  expect(activate).not.toHaveBeenCalled();
  expect(ports.release).toHaveBeenCalledTimes(3);
});
