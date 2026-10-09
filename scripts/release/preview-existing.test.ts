import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
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

function interruptedDownloads() {
  mkdirSync(root, { mode: 0o700 });
  const paths = [join(root, ".download-ABC123"), join(root, ".download-cdGkCc")] as const;
  for (const path of paths) {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "partial"), "download bytes");
  }
  return paths;
}

it.each(["student", "server"] as const)(
  "can restart a legacy interrupted %s download after confirmation",
  async (selected) => {
    const paths = interruptedDownloads();
    ports.question.mockResolvedValue("S");
    expect(await preparePreviewRoot(root, selected)).toBe(true);
    expect(paths.some((path) => existsSync(path))).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(ports.question).toHaveBeenCalledExactlyOnceWith(
      "¿Eliminar estas descargas temporales y reintentar? (s/n)",
      "n",
    );
    expect(output).toHaveBeenCalledWith(
      "Solo quedan descargas temporales de un intento anterior; no hay programas instalados ni datos del centro. Cierra cualquier otro instalador de Marea antes de continuar.\n",
    );
    expect(output).toHaveBeenLastCalledWith(
      "Descargas temporales eliminadas. Reintentando la instalación...\n",
    );
  },
);

it("keeps temporary downloads when cleanup is declined", async () => {
  const paths = interruptedDownloads();
  ports.question.mockResolvedValue("n");
  expect(await preparePreviewRoot(root, "server")).toBe(false);
  expect(paths.every((path) => existsSync(path))).toBe(true);
});

it.each([
  "installation",
  "student-state",
  "preview.json",
  "download-ABC123",
  "backup.download-ABC123",
  ".download-ABC12",
  ".download-ABC1234",
  ".download-ABC_12",
  ".download-ÁBC123",
  ".download-ABC123.txt",
  ".download-ABC123\n",
])("never treats %s as disposable download residue", async (name) => {
  const paths = interruptedDownloads();
  writeFileSync(join(root, name), "keep user state");
  await expect(preparePreviewRoot(root, "server")).rejects.toThrow(InstallerUsageError);
  expect(readFileSync(join(root, name), "utf8")).toBe("keep user state");
  expect(paths.every((path) => existsSync(path))).toBe(true);
  expect(ports.question).not.toHaveBeenCalled();
});

it.each(["new entry", "replacement"])(
  "does not clean up if a %s appears during confirmation",
  async (change) => {
    const paths = interruptedDownloads();
    ports.question.mockImplementation(() => {
      if (change === "new entry") writeFileSync(join(root, "preview.json"), "another installer");
      else {
        renameSync(paths[0], join(scratch, "original-download"));
        mkdirSync(paths[0], { mode: 0o700 });
      }
      return Promise.resolve("s");
    });
    await expect(preparePreviewRoot(root, "server")).rejects.toThrow(
      "La carpeta ha cambiado mientras respondías. No se ha borrado nada; vuelve a intentarlo cuando termine el otro instalador.",
    );
    expect(paths.every((path) => existsSync(path))).toBe(true);
  },
);

it("does not follow a download-shaped symlink", async () => {
  mkdirSync(root, { mode: 0o700 });
  symlinkSync(scratch, join(root, ".download-ABC123"));
  await expect(preparePreviewRoot(root, "server")).rejects.toThrow("canonical directory");
  expect(ports.question).not.toHaveBeenCalled();
  expect(existsSync(root)).toBe(true);
});

it("keeps downloads if the root becomes public while confirming", async () => {
  const paths = interruptedDownloads();
  ports.question.mockImplementation(() => {
    chmodSync(root, 0o755);
    return Promise.resolve("s");
  });
  await expect(preparePreviewRoot(root, "server")).rejects.toThrow("not private");
  expect(paths.every((path) => existsSync(path))).toBe(true);
});

it("keeps downloads when an entry is renamed during confirmation without changing the entry count", async () => {
  const paths = interruptedDownloads();
  ports.question.mockImplementation(() => {
    renameSync(paths[0], join(root, ".download-NEW123"));
    return Promise.resolve("s");
  });
  await expect(preparePreviewRoot(root, "server")).rejects.toThrow("La carpeta ha cambiado");
  expect(existsSync(paths[1])).toBe(true);
  expect(existsSync(join(root, ".download-NEW123"))).toBe(true);
});

it("keeps remaining downloads if another process removes an entry while confirming", async () => {
  const paths = interruptedDownloads();
  ports.question.mockImplementation(() => {
    rmSync(paths[0], { recursive: true });
    return Promise.resolve("s");
  });
  await expect(preparePreviewRoot(root, "server")).rejects.toThrow(
    "La carpeta ha cambiado mientras respondías. No se ha borrado nada; vuelve a intentarlo cuando termine el otro instalador.",
  );
  expect(existsSync(paths[1])).toBe(true);
});
