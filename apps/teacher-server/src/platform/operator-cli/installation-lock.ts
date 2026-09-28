import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  writeSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import type { InstallationCapability } from "../../governance/authority.js";
import { OperatorCliError } from "./errors.js";
import { currentUid, privateKind } from "./private-path.js";

export interface OwnedInstallation {
  readonly capability: InstallationCapability;
  /** True only when this descriptor's lock was still in place and has been removed. */
  readonly release: () => boolean;
}

function identity(status: Stats | undefined): string | undefined {
  return status && `${String(status.dev)}:${String(status.ino)}`;
}

/** Offline exclusive owner of `<root>/locks/installation.lock`; existing locks are never broken. */
export function acquireInstallation(root: string, uid = currentUid()): OwnedInstallation {
  const lockPath = join(root, "locks", "installation.lock");
  const locks = join(root, "locks");
  let descriptor: number;
  let rootIdentity: string | undefined;
  let directoryIdentity: string | undefined;
  try {
    if (
      realpathSync(root) !== root ||
      privateKind(root, uid) !== "directory" ||
      privateKind(locks, uid) !== "directory"
    )
      throw new Error();
    rootIdentity = identity(lstatSync(root));
    directoryIdentity = identity(lstatSync(locks));
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const busy = error instanceof Error && "code" in error && error.code === "EEXIST";
    throw new OperatorCliError(busy ? "installation-busy" : "installation-unavailable");
  }
  let held: string | undefined;
  try {
    // The owning process is recorded so an abandoned lock can be told apart from a live owner.
    writeSync(descriptor, JSON.stringify({ pid: process.pid }));
    held = identity(fstatSync(descriptor));
  } catch {
    closeSync(descriptor);
    throw new OperatorCliError("installation-unavailable");
  }
  const inPlace = () => {
    try {
      return (
        realpathSync(root) === root &&
        identity(lstatSync(root)) === rootIdentity &&
        identity(lstatSync(locks)) === directoryIdentity &&
        privateKind(root, uid) === "directory" &&
        privateKind(locks, uid) === "directory" &&
        privateKind(lockPath, uid) === "file" &&
        identity(lstatSync(lockPath)) === held
      );
    } catch {
      return false;
    }
  };
  let released: boolean | undefined;
  return {
    capability: Object.freeze({
      kind: "exclusive-installation-owner" as const,
      installationRoot: root,
      assertOwned: () => {
        if (released !== undefined || !inPlace()) throw new OperatorCliError("installation-lost");
        return undefined;
      },
    }),
    release: () => {
      if (released !== undefined) return released;
      released = inPlace();
      try {
        closeSync(descriptor);
        if (released) unlinkSync(lockPath);
      } catch {
        released = false;
      }
      return released;
    },
  };
}
