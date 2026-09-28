import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import type { OwnedInstallation } from "../operator-cli/installation-lock.js";
import { currentUid, privateKind } from "../operator-cli/private-path.js";

/** Where a person answers; not interactive when started without a terminal. */
export interface LockRecoveryTerminal {
  readonly interactive: boolean;
  write(text: string): void;
  /** One answer line, or undefined when input ends or the question is interrupted. */
  readLine(): Promise<string | undefined>;
}

export interface LockRecoveryDependencies {
  readonly terminal: LockRecoveryTerminal;
  /** Whether a process with this identifier exists right now. */
  readonly processExists: (pid: number) => boolean;
  readonly uid?: number;
}

interface PresentLock {
  readonly path: string;
  readonly identity: string;
  /** The recorded owner, or null when the record is empty, older or unreadable. */
  readonly pid: number | null;
}

const LOCK_RECORD_BYTES = 4_096;

function recordedPid(path: string): number | null {
  try {
    const parsed = z
      .object({ pid: z.number().int().positive() })
      .safeParse(JSON.parse(new TextDecoder().decode(readBoundedBytes(path, LOCK_RECORD_BYTES))));
    return parsed.success ? parsed.data.pid : null;
  } catch {
    return null;
  }
}

/** Both installation lock files that exist as private regular files; null when unusable. */
function presentLocks(root: string, uid: number): readonly PresentLock[] | null {
  try {
    const canonical = realpathSync(root);
    if (privateKind(canonical, uid) !== "directory") return null;
    const locks: PresentLock[] = [];
    for (const path of [
      join(canonical, ".marea-installation.lock"),
      join(canonical, "locks", "installation.lock"),
    ]) {
      const status = lstatSync(path, { throwIfNoEntry: false });
      if (status === undefined) continue;
      if (privateKind(path, uid) !== "file") return null;
      locks.push({
        path,
        identity: `${String(status.dev)}:${String(status.ino)}:${String(status.ctimeMs)}`,
        pid: recordedPid(path),
      });
    }
    return locks;
  } catch {
    return null;
  }
}

function question(running: readonly number[]): string {
  const warning =
    running.length === 0
      ? ""
      : `Warning: Marea appears to be running (process ${running.join(", ")}). Removing the lock is not recommended.\n`;
  return (
    "The installation is locked.\n" +
    "This usually means Marea did not shut down correctly (power loss, abrupt restart or forced stop).\n" +
    'If another Marea program is running on this installation right now, answer "no": removing the lock could damage data.\n' +
    warning +
    "Remove the lock and continue anyway? [y/N] "
  );
}

/**
 * Offers a person at a terminal to remove the installation locks left by a program that did not
 * shut down correctly. Nothing is removed without an explicit yes, without a terminal, or when
 * the locks changed while waiting for the answer. Recovery and index checks still run afterwards.
 */
export async function offerAbandonedLockRemoval(
  root: string,
  dependencies: LockRecoveryDependencies,
): Promise<boolean> {
  const uid = dependencies.uid ?? currentUid();
  const { terminal } = dependencies;
  const locks = presentLocks(root, uid);
  if (locks === null || locks.length === 0) return false;
  if (!terminal.interactive) {
    terminal.write(
      "The installation is locked. If Marea did not shut down correctly, run this command in a terminal to review and remove the lock.\n",
    );
    return false;
  }
  const pids = new Set(locks.flatMap((lock) => (lock.pid === null ? [] : [lock.pid])));
  terminal.write(question([...pids].filter((pid) => dependencies.processExists(pid))));
  const answer = (await terminal.readLine())?.trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    terminal.write("The lock was kept.\n");
    return false;
  }
  const current = presentLocks(root, uid);
  if (
    current?.map((lock) => lock.identity).join("\n") !==
    locks.map((lock) => lock.identity).join("\n")
  ) {
    terminal.write("The lock changed while waiting; nothing was removed.\n");
    return false;
  }
  try {
    for (const lock of locks) unlinkSync(lock.path);
  } catch {
    terminal.write("The lock could not be removed.\n");
    return false;
  }
  terminal.write("The lock was removed.\n");
  return true;
}

/** Acquires the operator lock, offering abandoned lock removal once when it is busy. */
export function acquireWithLockRecovery(
  acquire: (root: string) => OwnedInstallation,
  dependencies: LockRecoveryDependencies,
): (root: string) => Promise<OwnedInstallation> {
  return async (root) => {
    try {
      return acquire(root);
    } catch (error) {
      if (
        !(error instanceof OperatorCliError && error.code === "installation-busy") ||
        !(await offerAbandonedLockRemoval(root, dependencies))
      )
        throw error;
      return acquire(root);
    }
  };
}
