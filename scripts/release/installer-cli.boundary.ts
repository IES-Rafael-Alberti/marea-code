import {
  OperatorCliError,
  OperatorCliInterrupted,
} from "../../apps/teacher-server/src/platform/operator-cli/errors.js";

/** Handle terminal failures without changing diagnostics for other installer operations. */
export async function installerExitCode(operation: () => Promise<void>): Promise<number> {
  try {
    await operation();
    return 0;
  } catch (error) {
    if (error instanceof OperatorCliInterrupted) {
      process.stderr.write("Operación cancelada.\n");
      return error.exitCode;
    }
    if (!(error instanceof OperatorCliError)) throw error;
    process.stderr.write("No se ha podido completar la lectura de la entrada.\n");
    return 1;
  }
}
