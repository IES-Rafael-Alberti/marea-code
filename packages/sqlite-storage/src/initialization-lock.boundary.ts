import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import type { InitializationLockPort } from "./database-port.js";

interface LockWaiter {
  sleep(milliseconds: number): void;
}

export const systemLockWaiter: LockWaiter = Object.freeze({
  sleep(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
});

/** Everything the stale-lock decision observes, so tests can stand in for the machine. */
export interface LockEnvironment {
  readonly pid: number;
  readonly host: string;
  readonly now: () => number;
  /** True unless the process is known not to exist on this host. */
  readonly processAlive: (pid: number) => boolean;
  /** One operator-private diagnostic line. */
  readonly log: (line: string) => void;
}

/**
 * A lock with no readable owner was written by a release that recorded none, or is being written
 * right now. It is treated as abandoned only after this long, which exceeds any real initialization.
 */
export const legacyLockMaximumAgeMilliseconds = 10 * 60 * 1000;

export const systemLockEnvironment: LockEnvironment = Object.freeze({
  pid: process.pid,
  // Read on use: importing this module must not touch the operating system.
  get host(): string {
    return hostname();
  },
  now: () => Date.now(),
  processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // Only a missing process proves the owner is gone; EPERM means it exists.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  log(line: string): void {
    process.stderr.write(line);
  },
});

interface LockOwner {
  readonly pid: number;
  readonly host: string;
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    // A JSON null or a non-JSON text throws here and is treated as no owner.
    const { pid, host } = JSON.parse(text) as { readonly pid?: unknown; readonly host?: unknown };
    if (Number.isSafeInteger(pid) && (pid as number) > 0 && typeof host === "string")
      return { pid: pid as number, host };
  } catch {
    // No readable owner.
  }
  return undefined;
}

/** Why an existing lock may be removed, or undefined when it must be respected. */
function staleReason(lockPath: string, environment: LockEnvironment): string | undefined {
  let owner: LockOwner | undefined;
  try {
    owner = parseOwner(String(readFileSync(lockPath)));
    if (owner === undefined)
      return environment.now() - statSync(lockPath).mtimeMs > legacyLockMaximumAgeMilliseconds
        ? "legacy-lock-expired"
        : undefined;
  } catch {
    return undefined;
  }
  if (owner.host !== environment.host) return undefined;
  return environment.processAlive(owner.pid) ? undefined : "owner-not-running";
}

function removeStaleLock(lockPath: string, environment: LockEnvironment): boolean {
  const reason = staleReason(lockPath, environment);
  if (reason === undefined) return false;
  try {
    unlinkSync(lockPath);
  } catch {
    return false;
  }
  environment.log(
    JSON.stringify({ event: "initialization-lock-removed", reason, lockFile: lockPath }) + "\n",
  );
  return true;
}

export function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code: string }).code === "EEXIST"
  );
}

export function initializationLockPath(databasePath: string): string {
  const identity = createHash("sha256").update(databasePath).digest("hex");
  return join(dirname(databasePath), `.marea-init-${identity}.lock`);
}

function acquireLock(lockPath: string, waiter: LockWaiter, environment: LockEnvironment): number {
  const retryDelays = new Uint16Array(24).fill(250);
  for (const retryDelay of retryDelays) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      if (!removeStaleLock(lockPath, environment)) waiter.sleep(retryDelay);
    }
  }
  return openSync(lockPath, "wx", 0o600);
}

export function runWithInitializationFileLock<T>(
  databasePath: string,
  operation: () => T,
  waiter: LockWaiter = systemLockWaiter,
  environment: LockEnvironment = systemLockEnvironment,
): T {
  const lockPath = initializationLockPath(databasePath);
  const descriptor = acquireLock(lockPath, waiter, environment);
  try {
    writeSync(descriptor, JSON.stringify({ pid: environment.pid, host: environment.host }));
    closeSync(descriptor);
  } catch (error) {
    removeLockQuietly(lockPath);
    throw error;
  }
  try {
    const result = operation();
    unlinkSync(lockPath);
    return result;
  } catch (error) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Preserve the operation or first cleanup failure.
    }
    throw error;
  }
}

function removeLockQuietly(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Preserve the failure that triggered cleanup.
  }
}

export const fileInitializationLock: InitializationLockPort = Object.freeze({
  runExclusive: runWithInitializationFileLock,
});
