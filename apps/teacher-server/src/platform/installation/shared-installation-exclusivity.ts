import { lstatSync } from "node:fs";
import { join } from "node:path";

import {
  HostOperationError,
  type InstallationExclusivity,
  type InstallationLock,
} from "../operations/host/contracts.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import type { OwnedInstallation } from "../operator-cli/installation-lock.js";

function operatorLockPresent(root: string): boolean {
  return (
    lstatSync(join(root, "locks", "installation.lock"), { throwIfNoEntry: false }) !== undefined
  );
}

function sharedLock(host: InstallationLock, operator: OwnedInstallation): InstallationLock {
  let operatorReleased: boolean | undefined;
  const lock: InstallationLock = {
    canonicalRoot: host.canonicalRoot,
    async release(): Promise<void> {
      operatorReleased ??= operator.release();
      await host.release();
      if (!operatorReleased)
        throw new HostOperationError(
          "owner-busy",
          "the operator installation lock could not be released",
        );
    },
  };
  // The host runtime reads the terminal release state of the lock it actually released.
  Object.defineProperty(lock, "releaseState", { get: () => host.releaseState });
  return Object.freeze(lock);
}

/**
 * The host installation lock and the GOVERNANCE operator CLI lock guard the same installation.
 * Holding both makes the host, standalone maintenance and the operator CLI mutually
 * exclusive without changing either lock format. Existing locks are never broken.
 */
export function createSharedInstallationExclusivity(
  host: InstallationExclusivity,
  acquireOperatorLock: (root: string) => OwnedInstallation,
): InstallationExclusivity {
  return Object.freeze({
    async inspect(installationRoot: string) {
      const state = await host.inspect(installationRoot);
      return state === "free" && operatorLockPresent(installationRoot) ? "held" : state;
    },
    async acquire(installationRoot: string): Promise<InstallationLock> {
      const lock = await host.acquire(installationRoot);
      let operator: OwnedInstallation;
      try {
        operator = acquireOperatorLock(lock.canonicalRoot);
      } catch (error) {
        await lock.release();
        const busy = error instanceof OperatorCliError && error.code === "installation-busy";
        throw new HostOperationError(
          busy ? "owner-busy" : "path",
          "the operator installation lock is unavailable",
        );
      }
      return sharedLock(lock, operator);
    },
  });
}
