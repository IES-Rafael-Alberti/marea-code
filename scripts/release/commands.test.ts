import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
const mocked = vi.hoisted(() => ({
  installRelease: vi.fn(),
  prepareState: vi.fn(),
  privateDirectory: vi.fn(),
  readActivation: vi.fn(),
  uninstallRelease: vi.fn(),
  verifySignature: vi.fn(),
  withOfflineBackup: vi.fn(),
}));
vi.mock("./install.boundary.js", () => mocked);
vi.mock("./offline-backup.boundary.js", () => mocked);
import { installerMain } from "./installer-entry.js";
let stdout: MockInstance<typeof process.stdout.write>;
beforeEach(() => {
  vi.clearAllMocks();
  stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  stdout.mockRestore();
});
it("routes status, uninstall, install and update with explicit selections", async () => {
  mocked.readActivation.mockReturnValue(null);
  await installerMain(["status", "student"]);
  expect(mocked.readActivation).toHaveBeenCalledWith(expect.stringContaining(".marea-programs"));
  expect(stdout).toHaveBeenCalledWith("null\n");
  await installerMain(["uninstall", "server", "--root", "/private/programs"]);
  expect(mocked.uninstallRelease).toHaveBeenCalledWith(
    "/private/programs",
    "server",
    expect.any(Object),
  );
  for (const action of ["install", "update"]) {
    await installerMain([
      action,
      "server",
      "--version",
      "1.2.3",
      "--source",
      "candidate",
      "--repository",
      "o/r",
      "--ref",
      "refs/heads/main",
      "--installation",
      "/private/state",
    ]);
    expect(mocked.installRelease).toHaveBeenLastCalledWith(
      expect.objectContaining({
        component: "server",
        version: "1.2.3",
        source: "candidate",
        repository: "o/r",
        ref: "refs/heads/main",
        update: action === "update",
      }),
      expect.any(Object),
    );
    expect(stdout).toHaveBeenLastCalledWith(
      `Activated server 1.2.3. Start manually from ${join(homedir(), ".marea-programs", "server")}; active.json records the executable directory.\n`,
    );
    const ports = mocked.installRelease.mock.lastCall?.[1] as {
      withOfflineBackup: (op: () => Promise<void>) => Promise<void>;
    };
    const operation = () => Promise.resolve();
    await ports.withOfflineBackup(operation);
    expect(mocked.withOfflineBackup).toHaveBeenLastCalledWith("/private/state", operation);
  }
});
it("rejects unknown, duplicate, missing and unsupported CLI selections", async () => {
  for (const argv of [
    ["status", "bad"],
    ["bad", "student"],
    ["install", "student"],
    ["status", "student", "--unknown", "x"],
    ["status", "student", "--root"],
    ["status", "student", "--root", "x", "--root", "y"],
    ["status", "student", "", "x"],
  ])
    await expect(installerMain(argv)).rejects.toThrow();
});

it("prepares a server state root only on explicit selection", async () => {
  await installerMain(["prepare-state", "server", "--root", "/private/new-state"]);
  expect(mocked.prepareState).toHaveBeenCalledWith("/private/new-state");
  await expect(
    installerMain(["prepare-state", "student", "--root", "/private/new-state"]),
  ).rejects.toThrow("server");
  await expect(installerMain(["prepare-state", "server"])).rejects.toThrow("--root");
});

it("reports stable input diagnostics and never activates unsupported actions", async () => {
  for (const argv of [
    ["status", "student", "--root"],
    ["status", "student", "--unknown", "x"],
    ["status", "student", "--root", "x", "--root", "y"],
  ])
    await expect(installerMain(argv)).rejects.toThrow("Invalid installer arguments");
  await expect(installerMain(["unknown", "student"])).rejects.toThrow(
    "Use install, update, status or uninstall with explicit student/server component",
  );
  expect(mocked.installRelease).not.toHaveBeenCalled();
});
