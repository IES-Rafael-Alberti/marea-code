import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fileInitializationLock,
  initializationLockPath,
  runWithInitializationFileLock,
  systemLockWaiter,
} from "./initialization-lock.boundary.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "marea-sqlite-lock-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "marea.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("initialization file lock", () => {
  it("uses a deterministic adjacent hashed lock name", () => {
    const path = databasePath();
    const lockPath = initializationLockPath(path);

    expect(lockPath).toMatch(/\.marea-init-[a-f\d]{64}\.lock$/u);
    expect(lockPath).not.toContain("marea.sqlite.marea-init");
  });

  it("runs exclusively and removes the lock after success", () => {
    const path = databasePath();

    expect(fileInitializationLock.runExclusive(path, () => "result")).toBe("result");
    expect(existsSync(initializationLockPath(path))).toBe(false);
  });

  it("preserves an operation failure even when it already removed the lock", () => {
    const path = databasePath();

    expect(() =>
      runWithInitializationFileLock(path, () => {
        unlinkSync(initializationLockPath(path));
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
  });

  it("reports cleanup failure after an otherwise successful operation", () => {
    const path = databasePath();

    expect(() =>
      runWithInitializationFileLock(path, () => {
        unlinkSync(initializationLockPath(path));
        return "result";
      }),
    ).toThrow();
  });

  it("retries an existing lock and succeeds when it is released", () => {
    const path = databasePath();
    const lockPath = initializationLockPath(path);
    writeFileSync(lockPath, "occupied");
    const sleep = vi.fn(() => {
      unlinkSync(lockPath);
    });
    const waiter = { sleep };

    expect(runWithInitializationFileLock(path, () => "result", waiter)).toBe("result");
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("bounds lock waits and propagates non-contention filesystem errors", () => {
    const path = databasePath();
    writeFileSync(initializationLockPath(path), "occupied");
    const waiter = { sleep: vi.fn() };
    expect(() => {
      runWithInitializationFileLock(path, () => undefined, waiter);
    }).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(waiter.sleep).toHaveBeenCalledTimes(24);
    expect(waiter.sleep).toHaveBeenCalledWith(250);

    const absentParentPath = join(path, "absent", "marea.sqlite");
    const absentWaiter = { sleep: vi.fn() };
    expect(() => {
      runWithInitializationFileLock(absentParentPath, () => undefined, absentWaiter);
    }).toThrow();
    expect(absentWaiter.sleep).not.toHaveBeenCalled();
  });

  it("provides the production synchronous delay", () => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    systemLockWaiter.sleep(17);

    expect(wait).toHaveBeenCalledOnce();
    expect(wait.mock.calls[0]?.slice(1)).toEqual([0, 0, 17]);
  });
});
