import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface PtyProcess {
  readonly transcript: () => string;
  kill(signal?: NodeJS.Signals): void;
  waitForExit(timeoutMs?: number): Promise<ProcessResult>;
  waitForQuiet(quietMs?: number, timeoutMs?: number): Promise<void>;
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  write(text: string): void;
}

interface SpawnPtyOptions {
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly currentDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}

const POLL_INTERVAL_MS = 20;
const DEFAULT_TIMEOUT_MS = 10_000;
const PTY_CHILD_PID = /^MAREA_PTY_CHILD_PID=(\d+)\r?$/m;

function delay(): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, POLL_INTERVAL_MS);
  });
}

async function waitUntil(
  description: string,
  condition: () => boolean,
  failureContext: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.\n${failureContext().slice(-4_000)}`);
    }
    await delay();
  }
}

function collectProcess(child: ChildProcessWithoutNullStreams): {
  readonly result: Promise<ProcessResult>;
  readonly stderr: () => string;
  readonly stdout: () => string;
} {
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const result = new Promise<ProcessResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      resolveResult({ exitCode, signal, stderr, stdout });
    });
  });
  return { result, stderr: () => stderr, stdout: () => stdout };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`Timed out waiting for ${description}.`));
  }, timeoutMs);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function compileMarea(executablePath: string): Promise<void> {
  const packageRoot = resolve(process.cwd(), "apps/student");
  const child = spawn(
    "bun",
    ["build", "./src/marea-entry.boundary.ts", "--compile", "--outfile", executablePath],
    { cwd: packageRoot, env: process.env, stdio: "pipe" },
  );
  const output = collectProcess(child);
  const result = await withTimeout(output.result, 60_000, "the compiled marea build");
  if (result.exitCode !== 0) {
    throw new Error(`Compiling marea failed.\n${result.stdout}\n${result.stderr}`);
  }
  await access(executablePath);
}

export function spawnPty(options: SpawnPtyOptions): PtyProcess {
  const driverPath = resolve(process.cwd(), "test-support/terminal/pty-driver.py");
  const child = spawn(
    "python3",
    ["-u", driverPath, options.command, ...(options.arguments ?? [])],
    {
      cwd: options.currentDirectory,
      detached: true,
      env: {
        ...options.environment,
        COLUMNS: "100",
        LINES: "30",
        TERM: "xterm-256color",
      },
      stdio: "pipe",
    },
  );
  const output = collectProcess(child);
  const driverChildPid = (): number | null => {
    const captured = PTY_CHILD_PID.exec(output.stderr())?.[1];
    return captured === undefined ? null : Number.parseInt(captured, 10);
  };
  const transcript = () => `${output.stdout()}\n${output.stderr().replace(PTY_CHILD_PID, "")}`;
  return {
    transcript,
    kill(signal = "SIGKILL"): void {
      if (child.exitCode !== null || child.pid === undefined) return;
      const ptyChildPid = driverChildPid();
      try {
        if (ptyChildPid === null) process.kill(-child.pid, signal);
        else process.kill(ptyChildPid, signal);
      } catch {
        child.kill(signal);
      }
    },
    waitForExit: (timeoutMs = DEFAULT_TIMEOUT_MS) =>
      withTimeout(output.result, timeoutMs, "the PTY process to exit"),
    async waitForQuiet(quietMs = 200, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
      let observedLength = transcript().length;
      let lastChange = Date.now();
      await waitUntil(
        "PTY output to become quiet",
        () => {
          const currentLength = transcript().length;
          if (currentLength !== observedLength) {
            observedLength = currentLength;
            lastChange = Date.now();
          }
          return Date.now() - lastChange >= quietMs;
        },
        transcript,
        timeoutMs,
      );
    },
    async waitForText(text: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
      await waitUntil(
        `PTY output ${JSON.stringify(text)}`,
        () => transcript().includes(text) || child.exitCode !== null,
        transcript,
        timeoutMs,
      );
      if (!transcript().includes(text)) {
        const result = await output.result;
        throw new Error(
          `PTY process exited before rendering ${JSON.stringify(text)} ` +
            `(code ${String(result.exitCode)}, signal ${String(result.signal)}).\n` +
            transcript().slice(-4_000),
        );
      }
    },
    write(text: string): void {
      if (!child.stdin.writable) throw new Error("The PTY process no longer accepts input.");
      child.stdin.write(text);
    },
  };
}

export function launchCompiledStudent(
  command: string,
  projectRoot: string,
  serverUrl: string,
  stateRoot: string,
  arguments_: readonly string[] = [],
): PtyProcess {
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot });
  return spawnPty({
    command,
    arguments: arguments_,
    currentDirectory: projectRoot,
    environment: {
      ...process.env,
      LANG: "en-US",
      MAREA_SERVER_URL: serverUrl,
      MAREA_STATE_HOME: stateRoot,
    },
  });
}

export async function enrollCompiledStudent(
  pty: PtyProcess,
  account: {
    readonly displayName: string;
    readonly invitationCode: string;
    readonly login: string;
    readonly password: string;
  },
  waitForReady = true,
): Promise<void> {
  await pty.waitForText("How would you like to continue?");
  pty.write("\u001b[B\r");
  await pty.waitForText("Name shown to your teacher");
  pty.write(`${account.displayName}\r`);
  await pty.waitForText("Invitation code");
  pty.write(`${account.invitationCode}\r`);
  await pty.waitForText("Username");
  pty.write(`${account.login}\r`);
  await pty.waitForText("Password");
  pty.write(`${account.password}\r`);
  if (waitForReady) await pty.waitForText("Write to Marea", 15_000);
}
