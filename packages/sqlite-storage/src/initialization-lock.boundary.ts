import { createHash } from "node:crypto";
import { closeSync, openSync, unlinkSync } from "node:fs";
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

function acquireLock(lockPath: string, waiter: LockWaiter): number {
  const retryDelays = new Uint16Array(24).fill(250);
  for (const retryDelay of retryDelays) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      waiter.sleep(retryDelay);
    }
  }
  return openSync(lockPath, "wx", 0o600);
}

export function runWithInitializationFileLock<T>(
  databasePath: string,
  operation: () => T,
  waiter: LockWaiter = systemLockWaiter,
): T {
  const lockPath = initializationLockPath(databasePath);
  const descriptor = acquireLock(lockPath, waiter);
  try {
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
