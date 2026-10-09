import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory } from "./install.boundary.js";
import { InstallerUsageError } from "./installer-cli.boundary.js";
import { question } from "./preview-terminal.boundary.js";
import { uninstallPreview } from "./preview-uninstall.boundary.js";
import { isPreviewDownloadScratch } from "./preview-scratch.js";

async function clearInterruptedDownloads(root: string, entries: string[]): Promise<boolean> {
  const inspect = () =>
    JSON.stringify(
      entries.map((name) => {
        const path = join(root, name);
        privateDirectory(path);
        const status = lstatSync(path);
        return `${String(status.dev)}:${String(status.ino)}:${String(status.ctimeMs)}`;
      }),
    );
  const before = inspect();
  process.stdout.write(
    "Solo quedan descargas temporales de un intento anterior; no hay programas instalados ni datos del centro. Cierra cualquier otro instalador de Marea antes de continuar.\n",
  );
  if (
    (
      await question("¿Eliminar estas descargas temporales y reintentar? (s/n)", "n")
    ).toLowerCase() !== "s"
  )
    return false;
  privateDirectory(root);
  const current = readdirSync(root);
  if (
    current.length !== entries.length ||
    current.some((name) => !entries.includes(name)) ||
    inspect() !== before
  )
    throw new InstallerUsageError(
      "La carpeta ha cambiado mientras respondías. No se ha borrado nada; vuelve a intentarlo cuando termine el otro instalador.",
    );
  for (const name of entries) rmSync(join(root, name), { recursive: true });
  process.stdout.write("Descargas temporales eliminadas. Reintentando la instalación...\n");
  return true;
}

/** Recover download-only residues or retained school data; never adopt existing programs. */
export async function preparePreviewRoot(root: string, selected: "student" | "server") {
  if (!existsSync(root)) return true;
  privateDirectory(root);
  const entries = readdirSync(root);
  if (entries.length === 0) return true;
  if (entries.every(isPreviewDownloadScratch)) return clearInterruptedDownloads(root, entries);
  if (selected !== "server" || entries.length !== 1 || entries[0] !== "installation")
    throw new InstallerUsageError(
      `Ya existe una instalación o una carpeta incompleta en ${root}. Si conservas el lanzador, usa update para actualizar o uninstall --purge-data para borrar el servidor. No se ha modificado la carpeta.`,
    );
  const installation = join(root, "installation");
  privateDirectory(installation);
  process.stdout.write(
    `La desinstalación anterior conservó los datos del centro en ${installation}. Para empezar de cero hay que borrar esos datos, credenciales y copias de seguridad. Esta acción es irreversible.\n`,
  );
  if (
    (await question("¿Empezar de cero? Escribe BORRAR para eliminar los datos", "cancelar")) !==
    "BORRAR"
  ) {
    process.stdout.write("Instalación cancelada. Los datos del centro se conservan.\n");
    return false;
  }
  await uninstallPreview(root, { component: "server", installation }, ["--yes", "--purge-data"]);
  return true;
}
