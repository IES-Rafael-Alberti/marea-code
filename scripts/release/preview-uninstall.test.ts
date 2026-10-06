import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
const ports = vi.hoisted(() => ({
  question: vi.fn(),
  acquireInstallation: vi.fn(),
  release: vi.fn(),
  assertOwned: vi.fn(),
  removePosixPath: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("./preview-terminal.boundary.js", () => ports);
vi.mock("./preview-path.boundary.js", () => ports);
vi.mock("node:child_process", () => ports);
vi.mock("../../apps/teacher-server/src/platform/operator-cli/installation-lock.js", () => ports);
import { uninstallPreview } from "./preview-uninstall.boundary.js";
import { windowsLauncher } from "./preview-launchers.js";
let output: MockInstance<typeof process.stdout.write>;
let scratch: string;
let root: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const executable = Object.getOwnPropertyDescriptor(process, "execPath");
const settings = () => ({
  format: 1 as const,
  component: "student" as const,
  repository: "school/marea",
  channel: "preview" as const,
});
const server = () => ({
  ...settings(),
  component: "server" as const,
  installation: join(root, "installation"),
});
beforeEach(() => {
  vi.resetAllMocks();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-uninstall-")));
  root = join(scratch, "managed");
  for (const name of ["programs", "bin", "student-state", "installation"])
    mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, "preview.json"), "settings");
  writeFileSync(join(root, "installation", "data"), "private school data");
  writeFileSync(join(scratch, "project.txt"), "student work");
  ports.acquireInstallation.mockReturnValue({
    capability: { assertOwned: ports.assertOwned },
    release: ports.release,
  });
  ports.spawnSync.mockReturnValue({ status: 0 });
  output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  if (executable) Object.defineProperty(process, "execPath", executable);
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});
it("requires explicit consent and preserves projects and unowned root entries", async () => {
  ports.question.mockResolvedValue("no");
  await uninstallPreview(root, settings(), []);
  expect(existsSync(join(root, "programs"))).toBe(true);
  expect(ports.removePosixPath).not.toHaveBeenCalled();
  ports.question.mockResolvedValue("DESINSTALAR");
  await uninstallPreview(root, settings(), []);
  expect(ports.question).toHaveBeenCalledWith("¿Desinstalar Marea? Escribe DESINSTALAR", "no");
  expect(existsSync(join(root, "programs"))).toBe(false);
  expect(existsSync(join(root, "student-state"))).toBe(false);
  expect(existsSync(join(root, "preview.json"))).toBe(false);
  expect(readFileSync(join(scratch, "project.txt"), "utf8")).toBe("student work");
  expect(existsSync(join(root, "installation"))).toBe(true);
  expect(ports.acquireInstallation).not.toHaveBeenCalled();
  expect(ports.removePosixPath).toHaveBeenCalledWith(expect.any(String), join(root, "bin"));
});
it("preserves server data by default, and purges only after taking the exclusive lock", async () => {
  await uninstallPreview(root, server(), ["--yes"]);
  expect(readFileSync(join(root, "installation", "data"), "utf8")).toBe("private school data");
  expect(ports.acquireInstallation).toHaveBeenCalledWith(join(root, "installation"));
  expect(ports.assertOwned).toHaveBeenCalledOnce();
  expect(ports.release).toHaveBeenCalledOnce();
  await uninstallPreview(root, server(), ["--yes", "--purge-data"]);
  expect(existsSync(root)).toBe(false);
  expect(existsSync(join(scratch, "project.txt"))).toBe(true);
  expect(output).toHaveBeenCalledWith(expect.stringContaining("datos, credenciales y copias"));
});
it("refuses ambiguous arguments, external data directories, and a busy server without deleting files", async () => {
  for (const options of [["--bad"], ["--yes", "--yes"], ["--purge-data"]])
    await expect(uninstallPreview(root, settings(), options)).rejects.toThrow();
  await expect(
    uninstallPreview(root, { ...server(), installation: scratch }, ["--yes"]),
  ).rejects.toThrow("managed server");
  ports.acquireInstallation.mockImplementation(() => {
    throw new Error("installation-busy");
  });
  await expect(uninstallPreview(root, server(), ["--yes"])).rejects.toThrow("installation-busy");
  expect(existsSync(join(root, "preview.json"))).toBe(true);
  expect(ports.removePosixPath).not.toHaveBeenCalled();
});
it("rejects replaced managed directories and releases the server lock after a failure", async () => {
  rmSync(join(root, "programs"), { recursive: true });
  symlinkSync(scratch, join(root, "programs"));
  await expect(uninstallPreview(root, server(), ["--yes"])).rejects.toThrow("replaced with a link");
  expect(ports.release).toHaveBeenCalledOnce();
  expect(ports.removePosixPath).not.toHaveBeenCalled();
});
it("preserves a previous interrupted uninstall for inspection", async () => {
  mkdirSync(join(root, "installation-uninstalling"));
  await expect(uninstallPreview(root, server(), ["--yes", "--purge-data"])).rejects.toThrow(
    "needs inspection",
  );
  expect(existsSync(join(root, "installation", "data"))).toBe(true);
  expect(ports.release).toHaveBeenCalledOnce();
});
it("removes only the Windows user PATH entry and fails before file deletion if that fails", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  ports.spawnSync.mockReturnValueOnce({ status: 1 });
  await expect(uninstallPreview(root, settings(), ["--yes"])).rejects.toThrow("Windows PATH");
  expect(existsSync(join(root, "programs"))).toBe(true);
  await uninstallPreview(root, settings(), ["--yes"]);
  expect(existsSync(join(root, "programs"))).toBe(false);
  expect(ports.removePosixPath).not.toHaveBeenCalled();
  expect(JSON.stringify(ports.spawnSync.mock.calls).replaceAll(root, "/managed")).toMatchSnapshot(
    "remove only managed user PATH",
  );
});
it.each(["student", "server"] as const)(
  "upgrades only an owned legacy Windows launcher before retrying: %s",
  async (component) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "execPath", {
      value: join(root, "programs", "marea-install.exe"),
    });
    const config = component === "student" ? settings() : server();
    const path = join(root, "bin", component === "student" ? "marea.ps1" : "marea-teacher.ps1");
    writeFileSync(path, windowsLauncher(root, component, false));
    await expect(uninstallPreview(root, config, ["--yes"])).rejects.toThrow("temporary executable");
    expect(readFileSync(path, "utf8")).toBe(windowsLauncher(root, component));
    writeFileSync(path, "custom launcher");
    await expect(uninstallPreview(root, config, ["--yes"])).rejects.toThrow("temporary executable");
    expect(readFileSync(path, "utf8")).toBe("custom launcher");
    rmSync(path);
    symlinkSync(join(scratch, "project.txt"), path);
    await expect(uninstallPreview(root, config, ["--yes"])).rejects.toThrow(
      "launcher was replaced",
    );
    rmSync(path);
    linkSync(join(scratch, "project.txt"), path);
    await expect(uninstallPreview(root, config, ["--yes"])).rejects.toThrow(
      "launcher was replaced",
    );
    expect(ports.spawnSync).not.toHaveBeenCalled();
  },
);

it("explains student cleanup, server preservation and the explicit purge flag accurately", async () => {
  ports.question.mockResolvedValue("no");
  await uninstallPreview(root, settings(), []);
  expect(output).toHaveBeenLastCalledWith(
    "Se borrarán las sesiones guardadas; se conservarán tus proyectos fuera de la instalación.\nCierra las otras sesiones de Marea antes de continuar.\n",
  );
  await uninstallPreview(root, server(), []);
  expect(output).toHaveBeenLastCalledWith(
    `Se conservarán los datos del centro en ${join(root, "installation")}.\nCierra las otras sesiones de Marea antes de continuar.\n`,
  );
  await expect(uninstallPreview(root, settings(), ["--bad"])).rejects.toThrow(
    "Use uninstall [--yes] [--purge-data]",
  );
  await expect(uninstallPreview(root, settings(), ["--purge-data"])).rejects.toThrow(
    "--purge-data applies only to servers",
  );
  await uninstallPreview(root, settings(), ["--yes"]);
  expect(output).toHaveBeenLastCalledWith(
    "Marea desinstalado. Abre una terminal nueva para actualizar PATH.\n",
  );
});
it("can remove a running POSIX executable without taking the Windows repair path", async () => {
  Object.defineProperty(process, "execPath", { value: join(root, "programs", "marea-install") });
  await uninstallPreview(root, settings(), ["--yes"]);
  expect(existsSync(join(root, "programs"))).toBe(false);
});
