import { runNonInteractiveSmoke } from "./smoke.js";
import { startStudentTui } from "./start.js";
import { StudentTuiStartupError } from "./startup-error.js";
import type { StudentTuiCopy } from "./contracts.js";

export interface CliPorts {
  readonly start: typeof startStudentTui;
  readonly writeError: (message: string) => void;
  readonly writeOutput: (message: string) => void;
}

const DEFAULT_PORTS: CliPorts = Object.freeze({
  start: startStudentTui,
  writeError(message: string): void {
    process.stderr.write(`${message}\n`);
  },
  writeOutput(message: string): void {
    process.stdout.write(`${message}\n`);
  },
});

export async function runCli(
  arguments_: readonly string[],
  copy: StudentTuiCopy,
  ports: CliPorts = DEFAULT_PORTS,
): Promise<number> {
  if (arguments_.includes("--smoke")) {
    ports.writeOutput(runNonInteractiveSmoke());
    return 0;
  }

  try {
    const session = await ports.start(copy);
    const outcome = await session.outcome;
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof StudentTuiStartupError) {
      const message =
        error.code === "NON_INTERACTIVE" ? copy.errors.nonInteractive : copy.errors.rendererFailed;
      ports.writeError(message);
      return error.exitCode;
    }
    ports.writeError(copy.errors.unexpected);
    return 1;
  }
}
