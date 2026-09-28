import { z } from "zod";

import {
  acquireWithLockRecovery,
  type LockRecoveryDependencies,
} from "../installation/abandoned-lock-recovery.js";
import { processLockRecovery } from "../installation/lock-recovery-terminal.boundary.js";
import { runOperatorCli } from "../operator-cli/cli.js";
import { OperatorCliError, type ExitCode } from "../operator-cli/errors.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { processPorts } from "../operator-cli/main.js";
import type { InstallationCapability } from "../../governance/authority.js";
import type { ComposedInstallation } from "../operator-cli/cli.js";
import {
  createOperationsApplication,
  type OperationsApplication,
  type TransferInstallations,
} from "./operations-application.js";
import { runInstallationStatus } from "./installation-status.js";
import { operationsCommands } from "./operations-commands.js";
import { readOperationsConfig } from "./operations-config.js";

/** Configuration and storage failures are a missing prerequisite unless ownership was lost. */
export function composeOperations(
  capability: InstallationCapability,
  now: () => string,
  installations?: TransferInstallations,
): ComposedInstallation<OperationsApplication> {
  try {
    const config = readOperationsConfig(capability.installationRoot);
    const application = createOperationsApplication(capability, config, now, installations);
    const sidecars = (path: string) => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
    return {
      application,
      reserved: [
        `${capability.installationRoot}/locks`,
        `${capability.installationRoot}/config`,
        ...sidecars(config.databasePath),
        ...sidecars(config.indexPath),
        config.backupRoot,
      ],
      close: () => {
        application.close();
      },
    };
  } catch (error) {
    if (error instanceof OperatorCliError) throw error;
    throw new OperatorCliError("prerequisite-unavailable");
  }
}

/**
 * A transfer destination left locked by an interrupted transfer is offered the same abandoned
 * lock removal, naming that installation first so the question is never mistaken for the source.
 */
export function destinationInstallations(
  recovery: LockRecoveryDependencies,
): TransferInstallations {
  return {
    acquire: (root) => {
      let named = false;
      const terminal = recovery.terminal;
      return acquireWithLockRecovery(acquireInstallation, {
        ...recovery,
        terminal: {
          interactive: terminal.interactive,
          readLine: () => terminal.readLine(),
          write: (text) => {
            terminal.write(named ? text : `Transfer destination ${root}:\n${text}`);
            named = true;
          },
        },
      })(root);
    },
    read: readOperationsConfig,
  };
}

/** Production wiring for the compiled private `marea-operations` executable. */
export function runOperationsMain(
  argv: readonly string[] = process.argv.slice(2),
): Promise<ExitCode> {
  const ports = processPorts();
  const status = z
    .tuple([
      z.literal("--installation"),
      z.string(),
      z.literal("installation"),
      z.literal("status"),
    ])
    .safeParse(argv);
  if (status.success) return runInstallationStatus(status.data[1], ports);
  const recovery = processLockRecovery();
  return runOperatorCli(
    argv,
    {
      ...ports,
      acquire: acquireWithLockRecovery(acquireInstallation, recovery),
      compose: (capability) =>
        composeOperations(capability, ports.now, destinationInstallations(recovery)),
    },
    operationsCommands(),
  );
}
