import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FilesystemInstallationExclusivity } from "./filesystem-exclusivity.js";
import { HostOperationError } from "./contracts.js";
import type { InstallationLock } from "./contracts.js";
import {
  createRealLockFixture,
  expectOwnershipChanged,
  lockHandle,
  replaceLockRecord,
  transientInspectPath,
} from "./filesystem-real-support.fixture.js";

describe("FilesystemInstallationExclusivity additional boundaries", () => {
  it("rejects oversized and structurally invalid lock records", async () => {
    const { root, path } = await createRealLockFixture();
    const exclusivity = new FilesystemInstallationExclusivity();
    await writeFile(path, "x".repeat(4_097));
    await expect(exclusivity.acquire(root)).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation is already owned",
    });
    await rm(path);
    await writeFile(path, "{}");
    await expect(exclusivity.acquire(root)).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation is already owned",
    });
    await rm(path);
    const lock = await exclusivity.acquire(root);
    const originalLock = await readFile(path);
    await writeFile(path, "{}");
    await expect(lock.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock is invalid",
    });
    await writeFile(path, originalLock);
    await lock.release();

    const invalidRecords: unknown[] = [
      null,
      [],
      42,
      { token: "token", canonicalRoot: root, pid: 1 },
      { format: "marea-installation-lock:1", canonicalRoot: root, pid: 1 },
      { format: "marea-installation-lock:1", token: "token", pid: 1 },
      { format: "marea-installation-lock:1", token: "token", canonicalRoot: root },
    ];
    for (const record of invalidRecords) {
      const owner = await exclusivity.acquire(root);
      const originalOwner = await readFile(path);
      await writeFile(path, JSON.stringify(record));
      await expect(owner.release()).rejects.toMatchObject({
        code: "owner-busy",
        message:
          record !== null && typeof record !== "object"
            ? "installation lock record is not an object"
            : "installation lock is invalid",
      });
      await writeFile(path, originalOwner);
      await owner.release();
    }

    const valid = await exclusivity.acquire(root);
    const validRecord = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...validRecord, token: "different-token" }));
    await expect(valid.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock ownership changed",
    });
    await rm(path);

    const canonicalMismatch = await exclusivity.acquire(root);
    const canonicalRecord = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(
      path,
      JSON.stringify({ ...canonicalRecord, canonicalRoot: `${root}-different` }),
    );
    await expect(canonicalMismatch.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock ownership changed",
    });
    await rm(path);

    const invalidUtf8 = await exclusivity.acquire(root);
    const originalUtf8 = await readFile(path);
    const prefix = Buffer.from('{"format":"marea-installation-lock:1","token":"');
    const suffix = Buffer.from(`","canonicalRoot":"${root}","pid":1}`);
    await writeFile(path, Buffer.concat([prefix, Buffer.from([0xff]), suffix]));
    await expect(invalidUtf8.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock JSON is invalid",
    });
    await writeFile(path, originalUtf8);
    await invalidUtf8.release();
  });

  it("maps filesystem races and release close failures without stealing", async () => {
    const { root } = await createRealLockFixture();
    const exclusivity = new FilesystemInstallationExclusivity();
    const attempts = await Promise.allSettled([
      exclusivity.acquire(root),
      new FilesystemInstallationExclusivity().acquire(root),
    ]);
    const acquired = attempts.find(
      (attempt): attempt is PromiseFulfilledResult<InstallationLock> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(acquired).toBeDefined();
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "owner-busy" } });
    const lock = acquired?.value;
    if (lock === undefined) throw new Error("race did not acquire a lock");
    const handle = (lock as unknown as { handle: { close: () => Promise<void> } }).handle;
    handle.close = vi.fn(() => Promise.reject(new Error("close failed")));
    await expect(lock.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock could not be released",
    });
    expect(lock.releaseState).toBe("owned");
    handle.close = vi.fn(() => Promise.resolve());
    await expect(lock.release()).resolves.toBeUndefined();
    expect(lock.releaseState).toBe("released");

    const typed = await exclusivity.acquire(root);
    const typedHandle = (typed as unknown as { handle: { close: () => Promise<void> } }).handle;
    typedHandle.close = vi.fn(() =>
      Promise.reject(new HostOperationError("owner-busy", "close failed")),
    );
    await expect(typed.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "close failed",
    });

    const idempotent = await exclusivity.acquire(root);
    const idempotentHandle = (
      idempotent as unknown as {
        handle: { close: () => Promise<void> };
      }
    ).handle;
    idempotentHandle.close = vi.fn(() => Promise.resolve());
    await expect(idempotent.release()).resolves.toBeUndefined();
    await expect(idempotent.release()).resolves.toBeUndefined();
    expect(idempotentHandle.close).toHaveBeenCalledOnce();
    await expect(lstat(join(root, ".marea-installation.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retries release after a transient ownership inspection failure", async () => {
    const { root, path } = await createRealLockFixture();
    const transient = transientInspectPath("transient inspection failure", "EIO");
    const { inspectPath } = transient;
    const lock = await new FilesystemInstallationExclusivity(inspectPath as never).acquire(root);
    transient.markAcquired();

    await expect(lock.release()).rejects.toMatchObject({ code: "owner-busy" });
    await expect(lstat(path)).resolves.toBeDefined();
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses release when the path contents change without inode replacement", async () => {
    const { root, path } = await createRealLockFixture();
    const lock = await new FilesystemInstallationExclusivity().acquire(root);
    const original = await replaceLockRecord(path, "token", root);
    const handle = lockHandle(lock);
    const close = handle.close;
    handle.close = vi.fn(close);
    handle.read = vi.fn((buffer: Buffer) => {
      original.copy(buffer);
      return Promise.resolve({ bytesRead: original.byteLength, buffer });
    });
    await expectOwnershipChanged(lock.release());
    expect(handle.close).toHaveBeenCalledOnce();
    expect(lock.releaseState).toBe("ownership-lost");
    await expectOwnershipChanged(lock.release());
    expect(handle.close).toHaveBeenCalledOnce();
    await rm(path);
  });

  it("retries descriptor cleanup after proven ownership loss", async () => {
    const { root, path } = await createRealLockFixture();
    const lock = await new FilesystemInstallationExclusivity().acquire(root);
    await replaceLockRecord(path, "token", root);
    const handle = lockHandle(lock);
    handle.close = vi.fn(() => Promise.reject(new Error("close uncertain")));
    await expectOwnershipChanged(lock.release());
    expect(lock.releaseState).toBe("owned");
    handle.read = vi.fn(() => Promise.reject(new HostOperationError("limit", "read unavailable")));
    handle.close = vi.fn(() => Promise.resolve());
    await expect(lock.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock ownership changed",
    });
    expect(lock.releaseState).toBe("ownership-lost");
    await rm(path);
  });

  it("retains ownership when a generic owner-busy filesystem error is transient", async () => {
    const { root, path } = await createRealLockFixture();
    const transient = transientInspectPath("transient owner-busy inspection", "owner-busy");
    const { inspectPath } = transient;
    const lock = await new FilesystemInstallationExclusivity(inspectPath as never).acquire(root);
    transient.markAcquired();
    await expect(lock.release()).rejects.toMatchObject({ code: "owner-busy" });
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains ownership for typed non-owner release failures", async () => {
    const { root, path } = await createRealLockFixture();
    const lock = await new FilesystemInstallationExclusivity().acquire(root);
    const handle = (
      lock as unknown as {
        handle: {
          read: (buffer: Buffer) => Promise<{ bytesRead: number; buffer: Buffer }>;
          close: () => Promise<void>;
        };
      }
    ).handle;
    const read = handle.read;
    const close = handle.close;
    handle.read = vi.fn(() => Promise.reject(new HostOperationError("limit", "read failed")));
    handle.close = vi.fn(close);
    await expect(lock.release()).rejects.toMatchObject({
      code: "limit",
      message: "read failed",
    });
    expect(handle.close).not.toHaveBeenCalled();
    expect(lock.releaseState).toBe("owned");
    handle.read = read;
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses release when the lock path becomes a symbolic link", async () => {
    const { root } = await createRealLockFixture();
    const canonicalRoot = await realpath(root);
    const path = join(canonicalRoot, ".marea-installation.lock");
    let releasing = false;
    const inspectPath = async (candidate: string) => {
      const entry = await lstat(candidate);
      if (!releasing) return entry;
      const changed = Object.create(entry) as typeof entry;
      changed.isSymbolicLink = () => true;
      return changed;
    };
    const exclusivity = new FilesystemInstallationExclusivity(inspectPath as never);
    const lock = await exclusivity.acquire(root);
    releasing = true;
    await expect(lock.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock ownership changed",
    });
    await rm(path);
  });

  it("checks current and final lock identity independently during release", async () => {
    for (const phase of ["current", "final"] as const) {
      for (const identity of ["inode", "symlink"] as const) {
        const { root, path } = await createRealLockFixture();
        let releasing = false;
        let releaseLookups = 0;
        const inspectPath = async (candidate: string) => {
          const entry = await lstat(candidate);
          if (!releasing) return entry;
          releaseLookups += 1;
          if (phase === "current" && releaseLookups !== 1) return entry;
          if (phase === "final" && releaseLookups !== 2) return entry;
          if (identity === "inode")
            return Object.assign(Object.create(entry), { ino: entry.ino + 1 }) as typeof entry;
          const changed = Object.create(entry) as typeof entry;
          changed.isSymbolicLink = () => true;
          return changed;
        };
        const lock = await new FilesystemInstallationExclusivity(inspectPath as never).acquire(
          root,
        );
        releasing = true;
        await expectOwnershipChanged(lock.release());
        await expect(lstat(path)).resolves.toBeDefined();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("checks lock-record token and canonical root independently during release", async () => {
    for (const field of ["token", "canonicalRoot"] as const) {
      const { root, path } = await createRealLockFixture();
      const lock = await new FilesystemInstallationExclusivity().acquire(root);
      const original = await readFile(path);
      const changed = JSON.parse(original.toString()) as Record<string, unknown>;
      changed[field] = field === "token" ? "different-token" : `${root}-different`;
      await writeFile(path, JSON.stringify(changed));
      const handle = lockHandle(lock);
      handle.read = vi.fn((buffer: Buffer) => {
        original.copy(buffer);
        return Promise.resolve({ bytesRead: original.byteLength, buffer });
      });
      handle.close = vi.fn(() => Promise.resolve());
      await expectOwnershipChanged(lock.release());
      await expectOwnershipChanged(lock.release());
      expect(handle.close).toHaveBeenCalledOnce();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses release when the handle record changes while the path stays owned", async () => {
    for (const field of ["token", "canonicalRoot"] as const) {
      const { root, path } = await createRealLockFixture();
      const lock = await new FilesystemInstallationExclusivity().acquire(root);
      const original = await readFile(path);
      const changed = JSON.parse(original.toString()) as Record<string, unknown>;
      changed[field] = field === "token" ? "different-token" : `${root}-different`;
      const handle = (
        lock as unknown as {
          handle: { read: (buffer: Buffer) => Promise<{ bytesRead: number; buffer: Buffer }> };
        }
      ).handle;
      handle.read = vi.fn((buffer: Buffer) => {
        Buffer.from(JSON.stringify(changed)).copy(buffer);
        return Promise.resolve({ bytesRead: Buffer.byteLength(JSON.stringify(changed)), buffer });
      });
      await expectOwnershipChanged(lock.release());
      await expect(lstat(path)).resolves.toBeDefined();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an owner record that changes before its handle is read", async () => {
    for (const field of ["token", "canonicalRoot"] as const) {
      const { root, path } = await createRealLockFixture();
      const lock = await new FilesystemInstallationExclusivity().acquire(root);
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      record[field] = field === "token" ? "different-token" : `${root}-different`;
      await writeFile(path, JSON.stringify(record));
      await expect(lock.release()).rejects.toMatchObject({
        code: "owner-busy",
        message: "installation lock ownership changed",
      });
      await rm(root, { recursive: true, force: true });
    }
  });
});
