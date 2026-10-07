import {
  OperatorCliError,
  OperatorCliInterrupted,
} from "../../apps/teacher-server/src/platform/operator-cli/errors.js";

/** An expected, actionable installer diagnostic containing no private input. */
export class InstallerUsageError extends Error {}

/** Handle terminal failures without changing diagnostics for other installer operations. */
export async function installerExitCode(operation: () => Promise<void>): Promise<number> {
  try {
    await operation();
    return 0;
  } catch (error) {
    if (error instanceof InstallerUsageError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof OperatorCliInterrupted) {
      process.stderr.write("Operación cancelada.\n");
      return error.exitCode;
    }
    if (!(error instanceof OperatorCliError)) throw error;
    if (error.code === "installation-busy") {
      process.stderr.write(
        "La instalación está en uso o conserva un bloqueo. Cierra el servidor antes de continuar; los datos no se han borrado.\n",
      );
      return 1;
    }
    process.stderr.write("No se ha podido completar la lectura de la entrada.\n");
    return 1;
  }
}
