import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireInstallation,
  type OwnedInstallation,
} from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.js";
import type { PreviewSettings } from "./preview-channel.js";
import { powershellLiteral, windowsLauncher } from "./preview-launchers.js";
import { removePosixPath } from "./preview-path.boundary.js";
import { question } from "./preview-terminal.boundary.js";

type UninstallSettings = Pick<PreviewSettings, "component" | "installation">;

function prepareWindowsUninstall(root: string, settings: UninstallSettings): void {
  // On Windows an executable cannot remove itself. New launchers run uninstall from a temporary copy.
  if (
    process.platform === "win32" &&
    process.execPath.toLowerCase().startsWith(`${root}${sep}`.toLowerCase())
  ) {
    const path = join(
      root,
      "bin",
      `${settings.component === "student" ? "marea" : "marea-teacher"}.ps1`,
    );
    if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1)
      throw new Error("Windows launcher was replaced with a link");
    if (readFileSync(path, "utf8") === windowsLauncher(root, settings.component, false))
      writeFileSync(path, windowsLauncher(root, settings.component));
    throw new Error(
      "Close this command and run uninstall again through the installed PowerShell launcher (it uses a temporary executable).",
    );
  }
}

function removeManagedPath(bin: string): void {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_.TrimEnd('\\') -ine ${powershellLiteral(bin)}.TrimEnd('\\') }); [Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User')`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error("Could not remove the managed Windows PATH entry");
  } else removePosixPath(homedir(), bin);
}

function printUninstallScope(settings: UninstallSettings, purge: boolean): void {
  const detail = purge
    ? "También se borrarán los datos, credenciales y copias del centro."
    : settings.component === "server"
      ? `Se conservarán los datos del centro en ${String(settings.installation)}.`
      : "Se borrarán las sesiones guardadas; se conservarán tus proyectos fuera de la instalación.";
  process.stdout.write(`${detail}\nCierra las otras sesiones de Marea antes de continuar.\n`);
}

function retireInstallation(root: string, owner: OwnedInstallation): string {
  const destination = join(root, "installation-uninstalling");
  if (existsSync(destination)) throw new Error("Previous uninstall data needs inspection");
  if (!owner.release(destination))
    throw new Error("Could not retire the locked installation for removal");
  return destination;
}

async function selectDataRemoval(
  settings: UninstallSettings,
  options: readonly string[],
): Promise<boolean> {
  const purge = options.includes("--purge-data");
  if (settings.component !== "server" || purge || options.includes("--yes")) return purge;
  return (
    (
      await question("¿Borrar también los datos, credenciales y copias del centro? (s/n)", "n")
    ).toLowerCase() === "s"
  );
}

/** Remove only managed paths. Classroom data and user project directories are separate choices. */
export async function uninstallPreview(
  root: string,
  settings: UninstallSettings,
  options: readonly string[],
): Promise<void> {
  if (
    new Set(options).size !== options.length ||
    options.some((value) => !["--yes", "--purge-data"].includes(value))
  )
    throw new Error("Use uninstall [--yes] [--purge-data]");
  if (options.includes("--purge-data") && settings.component !== "server")
    throw new Error("--purge-data applies only to servers");
  const installation = settings.installation;
  if (settings.component === "server" && installation !== join(root, "installation"))
    throw new Error("Uninstall requires the managed server data directory");
  prepareWindowsUninstall(root, settings);
  const purge = await selectDataRemoval(settings, options);
  printUninstallScope(settings, purge);
  if (
    !options.includes("--yes") &&
    (await question("¿Desinstalar Marea? Escribe DESINSTALAR", "no")) !== "DESINSTALAR"
  )
    return;
  const owner = installation === undefined ? undefined : acquireInstallation(installation);
  let removedData: string | undefined;
  try {
    // Inspect before removing anything; do not traverse replaced top-level directories.
    const paths = ["programs", "bin", "student-state", "preview.json"];
    for (const name of paths) {
      const path = join(root, name);
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error("Managed uninstall path was replaced with a link");
    }
    const bin = join(root, "bin");
    removeManagedPath(bin);
    if (owner !== undefined) {
      owner.capability.assertOwned();
      if (purge) removedData = retireInstallation(root, owner);
    }
    for (const name of paths) rmSync(join(root, name), { recursive: true, force: true });
  } finally {
    owner?.release();
  }
  if (removedData !== undefined) rmSync(removedData, { recursive: true });
  if (readdirSync(root).length === 0) rmdirSync(root);
  process.stdout.write("Marea desinstalado. Abre una terminal nueva para actualizar PATH.\n");
  if (settings.component === "server" && !purge)
    process.stdout.write(
      `Datos conservados en ${String(installation)}. Al ejecutar de nuevo el instalador podrás borrarlos para empezar de cero.\n`,
    );
}
