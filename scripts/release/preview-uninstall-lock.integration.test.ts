import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  question: vi.fn(),
  removePosixPath: vi.fn(),
  spawnSync: vi.fn(),
  terminal: { interactive: true, write: vi.fn(), readLine: vi.fn() },
  processExists: vi.fn(),
}));
vi.mock("./preview-terminal.boundary.js", () => ports);
vi.mock("./preview-path.boundary.js", () => ports);
vi.mock("node:child_process", () => ports);
vi.mock(
  "../../apps/teacher-server/src/platform/installation/lock-recovery-terminal.boundary.js",
  () => ({
    processLockRecovery: () => ports,
  }),
);
import { uninstallPreview } from "./preview-uninstall.boundary.js";

let root: string;
let installation: string;
let locks: [string, string];
beforeEach(() => {
  vi.resetAllMocks();
  root = realpathSync(mkdtempSync(join(tmpdir(), "marea-uninstall-recovery-")));
  installation = join(root, "installation");
  for (const name of ["programs", "bin", "installation", "installation/locks"])
    mkdirSync(join(root, name), { mode: 0o700 });
  chmodSync(root, 0o700);
  writeFileSync(join(root, "preview.json"), "settings");
  writeFileSync(join(installation, "data"), "school data");
  locks = [
    join(installation, ".marea-installation.lock"),
    join(installation, "locks", "installation.lock"),
  ];
  for (const path of locks) writeFileSync(path, '{"pid":4242}', { mode: 0o600 });
  ports.processExists.mockReturnValue(false);
  ports.spawnSync.mockReturnValue({ status: 0 });
  ports.terminal.interactive = true;
  ports.terminal.readLine.mockResolvedValue("y");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const server = () => ({ component: "server" as const, installation });
function expectPreserved() {
  expect(readFileSync(join(installation, "data"), "utf8")).toBe("school data");
  expect(existsSync(join(root, "programs"))).toBe(true);
  expect(existsSync(join(root, "preview.json"))).toBe(true);
  expect(locks.every((path) => existsSync(path))).toBe(true);
  expect(ports.removePosixPath).not.toHaveBeenCalled();
  expect(ports.spawnSync).not.toHaveBeenCalled();
}

it.each([true, false])(
  "recovers abandoned host and operator locks while respecting data removal: %s",
  async (purge) => {
    ports.question.mockResolvedValueOnce(purge ? "s" : "n").mockResolvedValueOnce("DESINSTALAR");
    await uninstallPreview(root, server(), []);
    expect(ports.question).toHaveBeenCalledTimes(2);
    expect(ports.terminal.readLine).toHaveBeenCalledOnce();
    expect(ports.processExists).toHaveBeenCalledWith(4242);
    expect(ports.terminal.write).toHaveBeenCalledWith("The lock was removed.\n");
    expect(locks.some((path) => existsSync(path))).toBe(false);
    expect(existsSync(root)).toBe(!purge);
    expect(existsSync(join(root, "programs"))).toBe(false);
    if (!purge) expect(readFileSync(join(installation, "data"), "utf8")).toBe("school data");
  },
);

it.each([undefined, "n", ""])(
  "does not treat --yes as consent to break a lock: %s",
  async (answer) => {
    ports.terminal.readLine.mockResolvedValue(answer);
    await expect(uninstallPreview(root, server(), ["--yes", "--purge-data"])).rejects.toThrow(
      "installation-busy",
    );
    expect(ports.terminal.readLine).toHaveBeenCalledOnce();
    expectPreserved();
  },
);

it("keeps the entire installation when no terminal can confirm recovery", async () => {
  ports.terminal.interactive = false;
  await expect(uninstallPreview(root, server(), ["--yes", "--purge-data"])).rejects.toThrow(
    "installation-busy",
  );
  expect(ports.terminal.readLine).not.toHaveBeenCalled();
  expectPreserved();
});

it("warns about a live recorded owner and preserves its locks when recovery is declined", async () => {
  ports.processExists.mockReturnValue(true);
  ports.terminal.readLine.mockResolvedValue("n");
  await expect(uninstallPreview(root, server(), ["--yes", "--purge-data"])).rejects.toThrow(
    "installation-busy",
  );
  expect(ports.terminal.write).toHaveBeenCalledWith(
    expect.stringContaining("Warning: Marea appears to be running (process 4242)"),
  );
  expectPreserved();
});

it("does not remove a lock replaced while the person answers", async () => {
  ports.terminal.readLine.mockImplementation(() => {
    writeFileSync(locks[1], '{"pid":4243}');
    return Promise.resolve("y");
  });
  await expect(uninstallPreview(root, server(), ["--yes", "--purge-data"])).rejects.toThrow(
    "installation-busy",
  );
  expect(ports.terminal.write).toHaveBeenCalledWith(
    "The lock changed while waiting; nothing was removed.\n",
  );
  expectPreserved();
});
