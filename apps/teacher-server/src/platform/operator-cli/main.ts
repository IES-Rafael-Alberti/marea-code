import { acquireWithLockRecovery } from "../installation/abandoned-lock-recovery.js";
import { processLockRecovery } from "../installation/lock-recovery-terminal.boundary.js";
import { runOperatorCli, type OperatorCliDependencies } from "./cli.js";
import { composeInstallation } from "./composition.js";
import { OperatorCliError, type ExitCode } from "./errors.js";
import { acquireInstallation } from "./installation-lock.js";
import { writeSync } from "node:fs";

/** Observe OS write failures: Bun's standard-stream callbacks can hide EPIPE. */
export function writeOutput(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new OperatorCliError("output-failed");
    offset += written;
  }
}

/** Standard descriptors, private prompt, process signals and UTC clock of a compiled executable. */
export function processPorts(): Pick<
  OperatorCliDependencies,
  "stdout" | "stderr" | "prompt" | "stdin" | "signals" | "now"
> {
  return {
    stdout: (text) => {
      writeOutput(1, text);
    },
    stderr: (text) => {
      writeOutput(2, text);
    },
    prompt: (text) => {
      writeOutput(2, text);
    },
    stdin: process.stdin,
    signals: process,
    now: () => new Date().toISOString(),
  };
}

/** Production wiring for the compiled `marea-admin` executable. */
export function runMain(argv: readonly string[] = process.argv.slice(2)): Promise<ExitCode> {
  return runOperatorCli(argv, {
    ...processPorts(),
    acquire: acquireWithLockRecovery(acquireInstallation, processLockRecovery()),
    compose: composeInstallation,
  });
}
