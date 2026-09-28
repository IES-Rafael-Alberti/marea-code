import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath, unlink, readFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";

import {
  HostOperationError,
  type InstallationExclusivity,
  type InstallationLock,
} from "./contracts.js";

const LOCK_FILE = ".marea-installation.lock";
const LOCK_BYTES = 4_096;
type Lstat = typeof lstat;

interface LockRecord {
  readonly format: "marea-installation-lock:1";
  readonly token: string;
  readonly canonicalRoot: string;
  readonly pid: number;
}

class LockOwnershipLostError extends HostOperationError {}

function ownershipChangedError(): HostOperationError {
  return new LockOwnershipLostError("owner-busy", "installation lock ownership changed");
}

function lockPath(canonicalRoot: string): string {
  return join(canonicalRoot, LOCK_FILE);
}

async function canonicalizeRoot(input: string): Promise<string> {
  if (!isAbsolute(input))
    throw new HostOperationError("path", "installation root must be absolute");
  const normalized = resolve(input);
  let resolved: string;
  try {
    const rootEntry = await lstat(normalized);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory())
      throw new HostOperationError("path", "installation root is not a directory");
    resolved = await realpath(normalized);
    const confirmed = await lstat(normalized);
    if (
      confirmed.isSymbolicLink() ||
      !confirmed.isDirectory() ||
      confirmed.dev !== rootEntry.dev ||
      confirmed.ino !== rootEntry.ino
    )
      throw new HostOperationError("path", "installation root changed during inspection");
  } catch (error) {
    if (error instanceof HostOperationError) throw error;
    throw new HostOperationError("path", "installation root is unavailable");
  }
  return resolved;
}

function validateLock(value: unknown): LockRecord {
  if (value === null) throw new HostOperationError("owner-busy", "installation lock is invalid");
  if (typeof value !== "object")
    throw new HostOperationError("owner-busy", "installation lock record is not an object");
  const record = value as Partial<LockRecord>;
  const pid = record.pid ?? 0;
  if (
    record.format !== "marea-installation-lock:1" ||
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.canonicalRoot !== "string" ||
    record.canonicalRoot.length === 0 ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  )
    throw new HostOperationError("owner-busy", "installation lock is invalid");
  return record as LockRecord;
}

function parseLock(bytes: Uint8Array): LockRecord {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new HostOperationError("owner-busy", "installation lock JSON is invalid");
  }
  return validateLock(value);
}

async function assertLockPathAvailable(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink())
      throw new HostOperationError("path", "installation lock is a symbolic link");
    throw new HostOperationError("owner-busy", "installation is already owned");
  } catch (error) {
    if (error instanceof HostOperationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new HostOperationError("path", "installation lock cannot be inspected");
  }
}

async function removeOwnedLock(
  path: string,
  record: LockRecord,
  inode: number,
  inspectPath: Lstat = lstat,
): Promise<void> {
  const current = await inspectPath(path);
  if (current.ino !== inode || current.isSymbolicLink()) return;
  const currentRecord = parseLock(await readFile(path));
  if (currentRecord.token !== record.token || currentRecord.canonicalRoot !== record.canonicalRoot)
    return;
  const confirmed = await inspectPath(path);
  if (confirmed.ino === inode && !confirmed.isSymbolicLink()) await unlink(path);
}

async function verifyOwnedLock(
  path: string,
  record: LockRecord,
  inode: number,
  inspectPath: Lstat = lstat,
): Promise<void> {
  const current = await inspectPath(path);
  if (current.ino !== inode || current.isSymbolicLink()) throw ownershipChangedError();
  const currentRecord = parseLock(await readFile(path));
  if (currentRecord.token !== record.token || currentRecord.canonicalRoot !== record.canonicalRoot)
    throw ownershipChangedError();
  const confirmed = await inspectPath(path);
  if (confirmed.ino !== inode || confirmed.isSymbolicLink()) throw ownershipChangedError();
}

class FilesystemInstallationLock implements InstallationLock {
  #pathReleased = false;
  #handleClosed = false;
  #ownershipChanged = false;
  #releaseState: "owned" | "released" | "ownership-lost" = "owned";

  public get releaseState(): "owned" | "released" | "ownership-lost" {
    return this.#releaseState;
  }

  public constructor(
    public readonly canonicalRoot: string,
    private readonly path: string,
    private readonly token: string,
    private readonly handle: FileHandle,
    private readonly inode: number,
    private readonly inspectPath: Lstat,
  ) {}

  public async release(): Promise<void> {
    if (this.#ownershipChanged) return this.reportOwnershipLost();
    let failure: unknown;
    if (!this.#pathReleased) {
      try {
        const lockBytes = Buffer.alloc(LOCK_BYTES);
        const read = await this.handle.read(lockBytes, 0, LOCK_BYTES, 0);
        const own = parseLock(lockBytes.subarray(0, read.bytesRead));
        const current = await this.inspectPath(this.path);
        if (
          own.token !== this.token ||
          own.canonicalRoot !== this.canonicalRoot ||
          current.ino !== this.inode ||
          current.isSymbolicLink()
        )
          throw ownershipChangedError();
        const pathRecord = parseLock(await readFile(this.path));
        if (pathRecord.token !== this.token || pathRecord.canonicalRoot !== this.canonicalRoot)
          throw ownershipChangedError();
        const confirmed = await this.inspectPath(this.path);
        if (confirmed.ino !== this.inode || confirmed.isSymbolicLink())
          throw ownershipChangedError();
        await unlink(this.path);
        this.#pathReleased = true;
      } catch (error) {
        failure = error;
        if (this.isOwnershipLost(error)) this.#ownershipChanged = true;
      }
    }
    if (this.#ownershipChanged) return this.reportOwnershipLost(failure);
    if (!this.#handleClosed && this.#pathReleased) {
      try {
        await this.closeHandle();
        this.#releaseState = "released";
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure instanceof HostOperationError) throw failure;
    if (failure !== undefined)
      throw new HostOperationError("owner-busy", "installation lock could not be released");
  }

  private async closeHandle(): Promise<void> {
    if (this.#handleClosed) return;
    await this.handle.close();
    this.#handleClosed = true;
  }

  private async reportOwnershipLost(failure: unknown = ownershipChangedError()): Promise<never> {
    try {
      await this.closeHandle();
      this.#releaseState = "ownership-lost";
    } catch {
      // The descriptor remains retryable until it is actually closed.
    }
    throw failure;
  }

  private isOwnershipLost(error: unknown): boolean {
    return error instanceof LockOwnershipLostError;
  }
}

export class FilesystemInstallationExclusivity implements InstallationExclusivity {
  public constructor(private readonly inspectPath: Lstat = lstat) {}

  public async acquire(installationRoot: string): Promise<InstallationLock> {
    const canonicalRoot = await canonicalizeRoot(installationRoot);
    const path = lockPath(canonicalRoot);
    await assertLockPathAvailable(path);

    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new HostOperationError("owner-busy", "installation is already owned");
      throw new HostOperationError("path", "installation lock cannot be created");
    }

    const record: LockRecord = {
      format: "marea-installation-lock:1",
      token: randomUUID(),
      canonicalRoot,
      pid: process.pid,
    };
    let inode = 0;
    try {
      const body = new TextEncoder().encode(JSON.stringify(record));
      await handle.writeFile(body);
      const own = await handle.stat();
      inode = own.ino;
      await verifyOwnedLock(path, record, inode, this.inspectPath);
      await handle.sync();
      return new FilesystemInstallationLock(
        canonicalRoot,
        path,
        record.token,
        handle,
        inode,
        this.inspectPath,
      );
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // Preserve the lock creation error.
      }
      try {
        await removeOwnedLock(path, record, inode, this.inspectPath);
      } catch {
        // Without token and inode proof, preserve the lock and fail closed.
      }
      if (error instanceof HostOperationError) throw error;
      throw new HostOperationError("path", "installation lock cannot be initialized");
    }
  }

  public async inspect(installationRoot: string): Promise<"free" | "held" | "unknown"> {
    const canonicalRoot = await canonicalizeRoot(installationRoot);
    try {
      const entry = await lstat(lockPath(canonicalRoot));
      return entry.isSymbolicLink() || !entry.isFile() ? "unknown" : "held";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "free";
      return "unknown";
    }
  }
}

export const filesystemInstallationExclusivity = new FilesystemInstallationExclusivity();
