import { access, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { runCompiledSmoke, type VerifierDependencies } from "./compiled-authoring-verifier.js";
import {
  expectFailure,
  SyntheticChild,
  syntheticErrorThenDelayedCloseSpawn,
  syntheticErrorWithoutCloseSpawn,
  syntheticKillFailureSpawn,
  syntheticKillThrowSpawn,
  syntheticNoCloseSpawn,
  syntheticNoOutputSpawn,
  syntheticNonErrorChildSpawn,
  syntheticSpawn,
  syntheticTimeoutCloseSpawn,
  syntheticTimeoutErrorSpawn,
  syntheticTimeoutKillErrorCloseSpawn,
  timerHarness,
} from "../../test-support/verify-compiled-authoring.test-support.js";

type DirectoryList = string[];
const ownedDirectoryLists: DirectoryList[] = [];

describe("compiled authoring verifier failure paths", () => {
  it("exercises injected acquisition, cleanup, process and output failures", async () => {
    try {
      await expectFailure(Promise.reject(new Error("direct failure")), "direct failure");
      await proveNormalRun();
      await proveNormalRunWithMissingOutputStreams();
      await proveBuildFailure();
      await proveSmokeFailure();
      await proveAcquisitionFailure();
      await proveCleanupContinuation();
      await proveCombinedFailureAndCleanup();
      await proveNonErrorFailures();
      await proveNonErrorChildFailure();
      await proveKillCloseCleanupOrdering();
      await proveTimeoutProcessFailure();
      await proveTimeoutWithoutEvent();
      await proveErrorBeforeDelayedClose();
      await proveErrorWithoutClose();
      await proveTimeoutKillErrorClose();
      await proveNoCloseRetainsResources();
      await proveKillFailureRetainsResources();
      await proveKillThrowRetainsResources();
    } finally {
      for (const directories of ownedDirectoryLists) {
        await cleanupOwnedDirectories(directories);
        for (const directory of directories) await assertMissing(directory);
      }
    }
  });
});

function ownedDirectories(): DirectoryList {
  const directories: DirectoryList = [];
  ownedDirectoryLists.push(directories);
  return directories;
}

async function withOwnedCleanup(
  directories: DirectoryList,
  operation: () => Promise<void>,
): Promise<void> {
  let failure: Error | undefined;
  try {
    await operation();
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  await cleanupOwnedDirectories(directories);
  for (const directory of directories) await assertMissing(directory);
  if (failure !== undefined) throw failure;
}

async function proveNormalRun(): Promise<void> {
  const directories = ownedDirectories();
  const output: string[] = [];
  const encodings: string[] = [];
  const timers = timerHarness();
  await runCompiledSmoke({
    ...realDependencies,
    mkdtemp: recordDirectories(directories, (prefix) => {
      expect(prefix.endsWith(directories.length === 0 ? "compiled-" : "cwd-")).toBe(true);
    }),
    spawn: syntheticSpawn(0, 0, "build-output", "smoke-output", encodings),
    writeStdout: (value) => output.push(`stdout:${value}`),
    writeStderr: (value) => output.push(`stderr:${value}`),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  expect(output).toEqual(["stdout:smoke-output", "stderr:smoke-output"]);
  expect(encodings).toEqual(["utf8", "utf8", "utf8", "utf8"]);
  expect(timers.clearCount).toBe(2);
  expect(timers.active).toHaveLength(0);
  await assertMissing(directoryAt(directories, 0));
  await assertMissing(directoryAt(directories, 1));
}

async function proveNormalRunWithMissingOutputStreams(): Promise<void> {
  const directories = ownedDirectories();
  await runCompiledSmoke({
    ...realDependencies,
    mkdtemp: recordDirectories(directories),
    spawn: syntheticNoOutputSpawn(),
  });
  await assertMissing(directoryAt(directories, 0));
  await assertMissing(directoryAt(directories, 1));
}

async function proveBuildFailure(): Promise<void> {
  const directories = ownedDirectories();
  const events: string[] = [];
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticSpawn(7, 0, "build-output", "smoke-output"),
      event: (event) => events.push(event),
    }),
    "Compiled authoring build failed.\nbuild-output",
  );
  await assertMissing(directoryAt(directories, 0));
  await assertMissing(directoryAt(directories, 1));
  expect(events).toEqual(["compiled authoring build:close"]);
}

async function proveSmokeFailure(): Promise<void> {
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticSpawn(0, 7, "build-output", "smoke-output"),
    }),
    "Compiled authoring smoke exited 7.\nsmoke-output\nsmoke-output",
  );
  await assertMissing(directoryAt(directories, 0));
  await assertMissing(directoryAt(directories, 1));
}

async function proveAcquisitionFailure(): Promise<void> {
  const directories = ownedDirectories();
  let acquisitions = 0;
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: async (prefix) => {
        acquisitions += 1;
        if (acquisitions === 2) throw new Error("injected second-directory failure");
        const directory = await mkdtemp(prefix);
        directories.push(directory);
        return directory;
      },
    }),
    "injected second-directory failure",
  );
  await assertMissing(directoryAt(directories, 0));
}

async function proveCleanupContinuation(): Promise<void> {
  const directories = ownedDirectories();
  const attempts: string[] = [];
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      rm: async (path, options) => {
        attempts.push(path);
        expect(options).toEqual({ force: true, recursive: true });
        if (attempts.length === 1) throw new Error("injected cleanup failure");
        await rm(path, options);
      },
      spawn: syntheticSpawn(),
    }),
    "injected cleanup failure",
  );
  expect(attempts).toHaveLength(2);
  await assertMissing(directoryAt(directories, 0));
  await assertPresent(directoryAt(directories, 1));
}

async function proveCombinedFailureAndCleanup(): Promise<void> {
  const directories = ownedDirectories();
  try {
    await runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      rm: () => Promise.reject(new Error("injected combined cleanup failure")),
      spawn: syntheticSpawn(7),
    });
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(3);
    return;
  }
  throw new Error("Expected combined failure.");
}

async function proveNonErrorFailures(): Promise<void> {
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      mkdtemp: () => Promise.reject("injected non-error acquisition"),
      spawn: syntheticSpawn(),
    }),
    "injected non-error acquisition",
  );
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      rm: () => Promise.reject("injected non-error cleanup"),
      spawn: syntheticSpawn(),
    }),
    "injected non-error cleanup",
  );
}

async function proveNonErrorChildFailure(): Promise<void> {
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticNonErrorChildSpawn(),
      terminationTimeoutMs: 50,
    }),
    "synthetic non-error child",
  );
  await assertMissing(directoryAt(directories, 0));
  await assertMissing(directoryAt(directories, 1));
}

async function proveKillCloseCleanupOrdering(): Promise<void> {
  const directories = ownedDirectories();
  const events: string[] = [];
  const killSignals: (NodeJS.Signals | undefined)[] = [];
  const timers = timerHarness();
  let spawns = 0;
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      rm: async (path, options) => {
        events.push("cleanup");
        await rm(path, options);
      },
      spawn: ((...args: Parameters<typeof spawn>) => {
        const [command, commandArgs, options] = args;
        expect(options.cwd).toBeDefined();
        spawns += 1;
        const isBuild = command === "bun" && commandArgs.length > 0;
        expect(isBuild || command.endsWith("authoring-http-smoke")).toBe(true);
        const child = isBuild
          ? new SyntheticChild(() => undefined)
          : new SyntheticChild((signal) => {
              killSignals.push(signal);
              setTimeout(() => {
                child.emitClose(137);
              }, 5);
            });
        queueMicrotask(() => {
          if (isBuild) child.emitClose(0);
        });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        return child as never as ReturnType<typeof spawn>;
      }) as typeof spawn,
      smokeTimeoutMs: 1,
      terminationTimeoutMs: 50,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      event: (event) => events.push(event),
    }),
    "compiled authoring smoke timed out after the child closed.",
    "ChildTimeoutError",
  );
  expect(spawns).toBe(2);
  expect(events.indexOf("compiled authoring smoke:kill")).toBeLessThan(
    events.indexOf("compiled authoring smoke:close"),
  );
  expect(events).toContain("compiled authoring smoke:kill");
  expect(events).toContain("compiled authoring smoke:timeout-complete");
  expect(killSignals).toEqual(["SIGKILL"]);
  expect(timers.active).toHaveLength(0);
  expect(events.indexOf("compiled authoring smoke:close")).toBeLessThan(events.indexOf("cleanup"));
  await assertMissing(directoryAt(directories, 0));
  await assertMissing(directoryAt(directories, 1));
}

async function proveTimeoutProcessFailure(): Promise<void> {
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticTimeoutErrorSpawn(),
      smokeTimeoutMs: 100,
    }),
    "synthetic child exit",
  );
  await assertMissing(directoryAt(directories, 0));
  await assertMissing(directoryAt(directories, 1));
}

async function proveTimeoutWithoutEvent(): Promise<void> {
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticTimeoutCloseSpawn(),
      smokeTimeoutMs: 1,
    }),
    "compiled authoring smoke timed out after the child closed.",
  );
}

async function proveErrorBeforeDelayedClose(): Promise<void> {
  const directories = ownedDirectories();
  const events: string[] = [];
  await withOwnedCleanup(directories, async () => {
    await expectFailure(
      runCompiledSmoke({
        ...realDependencies,
        mkdtemp: recordDirectories(directories),
        spawn: syntheticErrorThenDelayedCloseSpawn(),
        rm: async (path, options) => {
          events.push("cleanup");
          await rm(path, options);
        },
        event: (event) => events.push(event),
        terminationTimeoutMs: 50,
      }),
      "synthetic child error",
    );
    expect(events.indexOf("compiled authoring smoke:error")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("compiled authoring smoke:error")).toBeLessThan(
      events.indexOf("compiled authoring smoke:close"),
    );
    expect(events.indexOf("compiled authoring smoke:close")).toBeLessThan(
      events.indexOf("cleanup"),
    );
  });
}

async function proveErrorWithoutClose(): Promise<void> {
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticErrorWithoutCloseSpawn(),
      smokeTimeoutMs: 100,
      terminationTimeoutMs: 1,
    }),
    "synthetic child error without close",
    "ChildTerminationError",
    () => directories.join(", "),
    "compiled authoring smoke child did not close before the termination deadline. synthetic child error without close",
  );
  await assertPresent(directoryAt(directories, 0));
  await assertPresent(directoryAt(directories, 1));
  await cleanupOwnedDirectories(directories);
}

async function proveTimeoutKillErrorClose(): Promise<void> {
  const directories = ownedDirectories();
  const timers = timerHarness();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticTimeoutKillErrorCloseSpawn(),
      smokeTimeoutMs: 1,
      terminationTimeoutMs: 50,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
    "timed out after the child closed",
    "ChildTimeoutError",
  );
  expect(timers.active).toHaveLength(0);
}

async function proveNoCloseRetainsResources(): Promise<void> {
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticNoCloseSpawn(),
      smokeTimeoutMs: 1,
      terminationTimeoutMs: 1,
    }),
    "did not close before the termination deadline",
    "ChildTerminationError",
    undefined,
    "compiled authoring smoke child did not close before the termination deadline.",
  );
  await expectRetainedResources(directories);
}

async function proveKillFailureRetainsResources(): Promise<void> {
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticKillFailureSpawn(),
      smokeTimeoutMs: 1,
      terminationTimeoutMs: 1,
    }),
    "did not close before the termination deadline",
    "ChildTerminationError",
  );
  await expectRetainedResources(directories);
}

async function proveKillThrowRetainsResources(): Promise<void> {
  const directories = ownedDirectories();
  await expectFailure(
    runCompiledSmoke({
      ...realDependencies,
      mkdtemp: recordDirectories(directories),
      spawn: syntheticKillThrowSpawn(),
      smokeTimeoutMs: 1,
      terminationTimeoutMs: 1,
    }),
    "synthetic kill failure",
    "ChildTerminationError",
  );
  await expectRetainedResources(directories, false);
}

const realDependencies: VerifierDependencies = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  rm: (path, options) => rm(path, options),
  spawn,
};

function recordDirectories(
  directories: DirectoryList,
  check?: (prefix: string) => void,
): (prefix: string) => Promise<string> {
  return async (prefix) => {
    check?.(prefix);
    const directory = await mkdtemp(prefix);
    directories.push(directory);
    return directory;
  };
}

async function cleanupOwnedDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) await rm(directory, { force: true, recursive: true });
}

function directoryAt(directories: readonly string[], index: number): string {
  const directory = directories[index];
  if (directory === undefined) throw new Error("Directory acquisition did not produce a path.");
  return directory;
}

async function assertMissing(directory: string): Promise<void> {
  await expect(access(directory)).rejects.toThrow();
}

async function assertPresent(directory: string): Promise<void> {
  await expect(access(directory)).resolves.toBeUndefined();
}

async function expectRetainedResources(
  directories: readonly string[],
  verifyMissing = true,
): Promise<void> {
  for (const directory of directories) await assertPresent(directory);
  await cleanupOwnedDirectories(directories);
  if (verifyMissing) for (const directory of directories) await assertMissing(directory);
}
