import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fileInitializationLock,
  initializationLockPath,
  legacyLockMaximumAgeMilliseconds,
  runWithInitializationFileLock,
  systemLockEnvironment,
  systemLockWaiter,
  type LockEnvironment,
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

function environment(overrides: Partial<LockEnvironment> = {}): LockEnvironment {
  return {
    pid: 4242,
    host: "this-host",
    now: () => Date.now(),
    processAlive: () => true,
    log: vi.fn(),
    ...overrides,
  };
}

function expectLockRespected(path: string): void {
  const waiter = { sleep: vi.fn() };
  const log = vi.fn();
  expect(() => {
    runWithInitializationFileLock(path, () => undefined, waiter, environment({ log }));
  }).toThrow(expect.objectContaining({ code: "EEXIST" }));
  expect(waiter.sleep).toHaveBeenCalledTimes(24);
  expect(log).not.toHaveBeenCalled();
}

const ownerlessRecords: [string, string][] = [
  ["empty", ""],
  ["not json", "occupied"],
  ["json scalar", "7"],
  ["json null", "null"],
  ["missing host", JSON.stringify({ pid: 5 })],
  ["fractional pid", JSON.stringify({ pid: 1.5, host: "this-host" })],
  ["zero pid", JSON.stringify({ pid: 0, host: "this-host" })],
  ["string pid", JSON.stringify({ pid: "5", host: "this-host" })],
  ["text host", JSON.stringify({ pid: 5, host: 7 })],
];

describe("initialization lock owner and orphan recovery", () => {
  it("records the owning process and host while the lock is held", () => {
    const path = databasePath();
    let recorded = "";

    runWithInitializationFileLock(
      path,
      () => {
        recorded = readFileSync(initializationLockPath(path), "utf8");
      },
      { sleep: vi.fn() },
      environment(),
    );

    expect(JSON.parse(recorded)).toEqual({ pid: 4242, host: "this-host" });
  });

  it("removes a lock whose recorded process is gone on this host and logs it", () => {
    const path = databasePath();
    const lockPath = initializationLockPath(path);
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, host: "this-host" }));
    const waiter = { sleep: vi.fn() };
    const log = vi.fn();
    const processAlive = vi.fn(() => false);

    expect(
      runWithInitializationFileLock(path, () => "ok", waiter, environment({ log, processAlive })),
    ).toBe("ok");

    expect(processAlive).toHaveBeenCalledWith(999_999);
    expect(waiter.sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      event: "initialization-lock-removed",
      reason: "owner-not-running",
      lockFile: lockPath,
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("never removes a lock held by a live process", () => {
    const path = databasePath();
    writeFileSync(initializationLockPath(path), JSON.stringify({ pid: 31, host: "this-host" }));
    expectLockRespected(path);
    expect(existsSync(initializationLockPath(path))).toBe(true);
  });

  it.each([
    ["owned by another host", JSON.stringify({ pid: 31, host: "other-host" })],
    ...ownerlessRecords,
  ])("keeps a lock whose owner record is %s", (_name, content) => {
    const path = databasePath();
    writeFileSync(initializationLockPath(path), content);
    const processAlive = vi.fn(() => false);

    expect(() => {
      runWithInitializationFileLock(
        path,
        () => undefined,
        { sleep: vi.fn() },
        environment({ processAlive }),
      );
    }).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(processAlive).not.toHaveBeenCalled();
  });

  it("removes an ownerless legacy lock only once it is older than the safe age", () => {
    const path = databasePath();
    const lockPath = initializationLockPath(path);
    writeFileSync(lockPath, "");
    const modified = 1_700_000_000;
    utimesSync(lockPath, modified, modified);
    const log = vi.fn();
    const at = (age: number) => modified * 1000 + age;

    expect(() => {
      runWithInitializationFileLock(
        path,
        () => undefined,
        { sleep: vi.fn() },
        environment({ log, now: () => at(legacyLockMaximumAgeMilliseconds) }),
      );
    }).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(log).not.toHaveBeenCalled();

    expect(
      runWithInitializationFileLock(
        path,
        () => "ok",
        { sleep: vi.fn() },
        environment({ log, now: () => at(legacyLockMaximumAgeMilliseconds + 1) }),
      ),
    ).toBe("ok");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      reason: "legacy-lock-expired",
    });
  });

  it.each(ownerlessRecords)(
    "treats a lock whose owner record is %s as legacy once it is old",
    (_name, content) => {
      const path = databasePath();
      const lockPath = initializationLockPath(path);
      writeFileSync(lockPath, content);
      const log = vi.fn();
      const processAlive = vi.fn(() => true);

      runWithInitializationFileLock(
        path,
        () => undefined,
        { sleep: vi.fn() },
        environment({
          log,
          processAlive,
          now: () => Date.now() + legacyLockMaximumAgeMilliseconds + 1000,
        }),
      );

      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        reason: "legacy-lock-expired",
      });
      expect(processAlive).not.toHaveBeenCalled();
    },
  );

  it("waits instead of judging a lock it cannot read", () => {
    const path = databasePath();
    mkdirSync(initializationLockPath(path));
    expectLockRespected(path);
  });

  it("keeps waiting when the lock vanishes or cannot be removed", () => {
    const path = databasePath();
    const lockPath = initializationLockPath(path);
    writeFileSync(lockPath, JSON.stringify({ pid: 31, host: "this-host" }));
    const log = vi.fn();
    const vanished = {
      sleep: vi.fn(() => {
        unlinkSync(lockPath);
      }),
    };

    expect(runWithInitializationFileLock(path, () => "ok", vanished, environment({ log }))).toBe(
      "ok",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("does not log a removal that another process won", () => {
    const path = databasePath();
    const lockPath = initializationLockPath(path);
    writeFileSync(lockPath, JSON.stringify({ pid: 31, host: "this-host" }));
    const log = vi.fn();
    const processAlive = vi.fn(() => {
      unlinkSync(lockPath);
      return false;
    });

    const waiter = { sleep: vi.fn() };
    expect(() => {
      runWithInitializationFileLock(
        path,
        () => undefined,
        waiter,
        environment({ log, processAlive }),
      );
    }).not.toThrow();
    expect(log).not.toHaveBeenCalled();
    expect(waiter.sleep).toHaveBeenCalledOnce();
  });

  it("reads liveness from the operating system", () => {
    expect(systemLockEnvironment.processAlive(process.pid)).toBe(true);
    const child = exitedProcessId();
    expect(systemLockEnvironment.processAlive(child)).toBe(false);
    expect(systemLockEnvironment.pid).toBe(process.pid);
    expect(systemLockEnvironment.host).toBe(hostname());
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    systemLockEnvironment.log("line\n");
    expect(write).toHaveBeenCalledWith("line\n");
    expect(systemLockEnvironment.now()).toBeGreaterThan(0);
  });

  it("treats a permission error as a live process", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(systemLockEnvironment.processAlive(1)).toBe(true);
    kill.mockImplementation(() => {
      throw new Error("no code");
    });
    expect(systemLockEnvironment.processAlive(1)).toBe(true);
    kill.mockRestore();
  });
});

function exitedProcessId(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid;
}
