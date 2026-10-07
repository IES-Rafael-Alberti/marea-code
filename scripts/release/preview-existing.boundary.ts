import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory } from "./install.boundary.js";
import { InstallerUsageError } from "./installer-cli.boundary.js";
import { question } from "./preview-terminal.boundary.js";
import { uninstallPreview } from "./preview-uninstall.boundary.js";

/** Recognize only the data-only root left by managed uninstall; never adopt an existing program. */
export async function preparePreviewRoot(root: string, selected: "student" | "server") {
  if (!existsSync(root)) return true;
  privateDirectory(root);
  const entries = readdirSync(root);
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
