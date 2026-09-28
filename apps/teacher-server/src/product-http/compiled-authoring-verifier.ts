import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectoryRoot = dirname(packageRoot);
type MakeTempDirectory = (prefix: string) => Promise<string>;
type RemoveDirectory = (
  path: string,
  options: { readonly force?: boolean; readonly recursive?: boolean },
) => Promise<void>;

export interface VerifierDependencies {
  readonly mkdtemp: MakeTempDirectory;
  readonly rm: RemoveDirectory;
  readonly spawn: typeof spawn;
  readonly buildTimeoutMs?: number;
  readonly smokeTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  readonly setTimer?: typeof setTimeout;
  readonly event?: (name: string) => void;
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
  readonly clearTimer?: typeof clearTimeout;
}

const realDependencies: VerifierDependencies = {
  mkdtemp,
  rm,
  spawn,
  writeStdout: process.stdout.write.bind(process.stdout),
  writeStderr: process.stderr.write.bind(process.stderr),
  setTimer: setTimeout,
};

export async function runCompiledSmoke(
  dependencies: VerifierDependencies = realDependencies,
): Promise<void> {
  const acquiredDirectories: string[] = [];
  let failure: Error | undefined;
  try {
    const temporaryDirectory = await dependencies.mkdtemp(
      join(temporaryDirectoryRoot, "marea-authoring-compiled-"),
    );
    acquiredDirectories.push(temporaryDirectory);
    const unrelatedWorkingDirectory = await dependencies.mkdtemp(
      join(temporaryDirectoryRoot, "marea-authoring-cwd-"),
    );
    acquiredDirectories.push(unrelatedWorkingDirectory);
    const executable = join(temporaryDirectory, "authoring-http-smoke");
    const build = dependencies.spawn(
      "bun",
      ["build", "./smoke/compiled-skill-authoring-http.ts", "--compile", "--outfile", executable],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const buildExit = await withChildTimeout(
      build,
      "compiled authoring build",
      dependencies.buildTimeoutMs,
      dependencies.event,
      dependencies.clearTimer,
      dependencies.terminationTimeoutMs,
      dependencies.setTimer,
    );
    if (buildExit.code !== 0)
      throw new Error(`Compiled authoring build failed.\n${buildExit.stderr}`);
    const run = dependencies.spawn(executable, [], {
      cwd: unrelatedWorkingDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runExit = await withChildTimeout(
      run,
      "compiled authoring smoke",
      dependencies.smokeTimeoutMs,
      dependencies.event,
      dependencies.clearTimer,
      dependencies.terminationTimeoutMs,
      dependencies.setTimer,
    );
    if (runExit.code !== 0)
      throw new Error(
        `Compiled authoring smoke exited ${String(runExit.code)}.\n${runExit.stdout}\n${runExit.stderr}`,
      );
    dependencies.writeStdout?.(runExit.stdout);
    dependencies.writeStderr?.(runExit.stderr);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  if (failure instanceof ChildTerminationError) {
    const retained = acquiredDirectories.join(", ");
    throw new AggregateError(
      [failure, new Error(`Retained verifier resources: ${retained}`)],
      "Compiled authoring verifier failed without safe cleanup.",
    );
  }
  const cleanupTasks = [...acquiredDirectories]
    .reverse()
    .map((directory) => () => dependencies.rm(directory, { force: true, recursive: true }));
  const cleanupErrors = await cleanupAll(cleanupTasks);
  if (failure !== undefined || cleanupErrors.length > 0) {
    const failures = [...(failure === undefined ? [] : [failure]), ...cleanupErrors];
    throw new AggregateError(failures, "Compiled authoring verifier failed.");
  }
}

async function cleanupAll(tasks: readonly (() => Promise<void>)[]): Promise<readonly Error[]> {
  const errors: Error[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

class ChildTimeoutError extends Error {
  public constructor(label: string) {
    super(`${label} timed out after the child closed.`);
    this.name = "ChildTimeoutError";
  }
}

class ChildTerminationError extends Error {
  public constructor(label: string, cause?: Error) {
    super(
      `${label} child did not close before the termination deadline.${
        cause === undefined ? "" : ` ${cause.message}`
      }`,
    );
    this.name = "ChildTerminationError";
  }
}

async function withChildTimeout(
  child: ReturnType<typeof spawn>,
  label: string,
  milliseconds = 30_000,
  event?: (name: string) => void,
  clearTimer: typeof clearTimeout = clearTimeout,
  terminationMilliseconds = 5_000,
  setTimer: typeof setTimeout = setTimeout,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  let childError: Error | undefined;
  let timeoutError: ChildTimeoutError | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectCompletion!: (reason: Error) => void;
  const completion = new Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolvePromise, reject) => {
    rejectCompletion = reject;
    child.once("error", (error) => {
      childError = normalizeError(error);
      event?.(`${label}:error`);
      terminationTimer ??= setTimer(() => {
        rejectCompletion(new ChildTerminationError(label, childError));
      }, terminationMilliseconds);
    });
    child.once("close", (code) => {
      event?.(`${label}:close`);
      if (timeoutError !== undefined) {
        event?.(`${label}:timeout-complete`);
        rejectCompletion(timeoutError);
        return;
      }
      if (childError !== undefined) {
        rejectCompletion(childError);
        return;
      }
      resolvePromise({ code, stderr, stdout });
    });
  });
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimer(() => {
      const error = new ChildTimeoutError(label);
      timeoutError = error;
      event?.(`${label}:kill`);
      try {
        child.kill("SIGKILL");
      } catch (killError) {
        terminationTimer ??= setTimer(() => {
          reject(new ChildTerminationError(label, normalizeError(killError as Error | string)));
        }, terminationMilliseconds);
        return;
      }
      terminationTimer ??= setTimer(() => {
        reject(new ChildTerminationError(label));
      }, terminationMilliseconds);
    }, milliseconds);
  });
  try {
    const result = await Promise.race([completion, timeout]);
    return result;
  } finally {
    clearTimer(timer);
    if (terminationTimer !== undefined) clearTimer(terminationTimer);
  }
}

function normalizeError(error: Error | string): Error {
  return error instanceof Error ? error : new Error(error);
}
