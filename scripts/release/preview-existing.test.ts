import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { securePrivatePath } from "@marea/private-filesystem";
import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.js";
import { InstallerUsageError } from "./installer-cli.boundary.js";
import { preparePreviewRoot } from "./preview-existing.boundary.js";

const ports = vi.hoisted(() => ({ question: vi.fn(), removePosixPath: vi.fn() }));
vi.mock("./preview-terminal.boundary.js", () => ports);
vi.mock("./preview-path.boundary.js", () => ports);
let scratch: string;
let root: string;
let output: MockInstance<typeof process.stdout.write>;
beforeEach(() => {
  vi.resetAllMocks();
  output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-existing-")));
  root = join(scratch, "server");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});
function retained() {
  const installation = join(root, "installation");
  for (const path of [root, installation, join(installation, "locks")]) {
    mkdirSync(path, { mode: 0o700 });
    securePrivatePath(path, 0o700);
  }
  writeFileSync(join(installation, "school-data"), "private retained data", { mode: 0o600 });
  return installation;
}

it("accepts an absent root without questions or filesystem changes", async () => {
  expect(await preparePreviewRoot(root, "server")).toBe(true);
  expect(await preparePreviewRoot(root, "student")).toBe(true);
  expect(existsSync(root)).toBe(false);
  expect(ports.question).not.toHaveBeenCalled();
});

it.each(["", "cancelar", "no", "borrar"])(
  "keeps retained data unless deletion is explicit: %s",
  async (answer) => {
    const installation = retained();
    ports.question.mockResolvedValue(answer);
    expect(await preparePreviewRoot(root, "server")).toBe(false);
    expect(readFileSync(join(installation, "school-data"), "utf8")).toBe("private retained data");
    expect(ports.question).toHaveBeenCalledExactlyOnceWith(
      "¿Empezar de cero? Escribe BORRAR para eliminar los datos",
      "cancelar",
    );
    expect(output).toHaveBeenCalledWith(
      `La desinstalación anterior conservó los datos del centro en ${installation}. Para empezar de cero hay que borrar esos datos, credenciales y copias de seguridad. Esta acción es irreversible.\n`,
    );
    expect(output).toHaveBeenLastCalledWith(
      "Instalación cancelada. Los datos del centro se conservan.\n",
    );
    expect(ports.removePosixPath).not.toHaveBeenCalled();
  },
);

it("removes only the explicitly selected retained installation, without making a backup", async () => {
  retained();
  writeFileSync(join(scratch, "unowned"), "keep");
  ports.question.mockResolvedValue("BORRAR");
  expect(await preparePreviewRoot(root, "server")).toBe(true);
  expect(existsSync(root)).toBe(false);
  expect(readFileSync(join(scratch, "unowned"), "utf8")).toBe("keep");
});

it("refuses deletion while the retained installation is owned by a server", async () => {
  const installation = retained();
  ports.question.mockResolvedValue("BORRAR");
  const owner = acquireInstallation(installation);
  try {
    await expect(preparePreviewRoot(root, "server")).rejects.toThrow("installation-busy");
    expect(readFileSync(join(installation, "school-data"), "utf8")).toBe("private retained data");
  } finally {
    owner.release();
  }
});

it.each(["student", "server"] as const)(
  "rejects unknown, partial or installed roots for %s",
  async (selected) => {
    retained();
    if (selected === "server") writeFileSync(join(root, "preview.json"), "existing settings");
    await expect(preparePreviewRoot(root, selected)).rejects.toThrow(InstallerUsageError);
    await expect(preparePreviewRoot(root, selected)).rejects.toThrow(
      `Ya existe una instalación o una carpeta incompleta en ${root}. Si conservas el lanzador, usa update para actualizar o uninstall --purge-data para borrar el servidor. No se ha modificado la carpeta.`,
    );
    expect(ports.question).not.toHaveBeenCalled();
    expect(existsSync(join(root, "installation", "school-data"))).toBe(true);
  },
);

it("accepts an empty failed-download root but rejects unrelated entries", async () => {
  mkdirSync(root, { mode: 0o700 });
  securePrivatePath(root, 0o700);
  expect(await preparePreviewRoot(root, "server")).toBe(true);
  expect(await preparePreviewRoot(root, "student")).toBe(true);
  writeFileSync(join(root, "unrelated"), "keep");
  await expect(preparePreviewRoot(root, "server")).rejects.toThrow(InstallerUsageError);
  expect(readFileSync(join(root, "unrelated"), "utf8")).toBe("keep");
  expect(ports.question).not.toHaveBeenCalled();
});

it.each(["root", "installation"])(
  "rejects replaced %s paths before asking to delete",
  async (selected) => {
    retained();
    const path = selected === "root" ? root : join(root, "installation");
    rmSync(path, { recursive: true });
    symlinkSync(scratch, path);
    await expect(preparePreviewRoot(root, "server")).rejects.toThrow(
      "Installation must be a canonical directory",
    );
    expect(ports.question).not.toHaveBeenCalled();
  },
);
