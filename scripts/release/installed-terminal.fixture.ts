import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnPty, type ProcessResult, type PtyProcess } from "../../test-support/terminal/pty.js";

/** The journey is shared; only the OS terminal transport differs. */
export function launchInstalledClient(
  executable: string,
  project: string,
  server: string,
  state: string,
): PtyProcess {
  const environment = {
    ...process.env,
    MAREA_SERVER_URL: server,
    MAREA_STATE_HOME: state,
    LANG: "en-US",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: resolve(state, "unused-global-gitconfig"),
  };
  execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet"], {
    cwd: project,
    env: environment,
    stdio: "pipe",
  });
  if (process.platform !== "win32")
    return spawnPty({
      command: executable,
      arguments: ["--lang", "en"],
      currentDirectory: project,
      environment,
    });
  const child = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve(import.meta.dirname, "installed-conpty-driver.ps1"),
      "-Executable",
      executable,
    ],
    {
      cwd: project,
      env: environment,
      stdio: "pipe",
    },
  );
  let output = "";
  let errors = "";
  let nativePid: number | undefined;
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    output += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    errors += text;
    const match = /MAREA_CONPTY_PID=(\d+)/u.exec(errors);
    if (match) nativePid = Number(match[1]);
  });
  const result = new Promise<ProcessResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolveResult({ exitCode, signal, stderr: errors, stdout: output });
    });
  });
  const transcript = () => output;
  async function until(check: () => boolean, timeout: number, description: string) {
    const deadline = Date.now() + timeout;
    while (!check()) {
      if (Date.now() >= deadline || child.exitCode !== null)
        throw new Error(`${description}\n${output.slice(-4000)}\n${errors}`);
      await delay(20);
    }
  }
  return {
    transcript,
    kill() {
      if (child.exitCode !== null) return;
      if (nativePid !== undefined) {
        try {
          process.kill(nativePid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      } else child.kill();
    },
    async waitForExit(timeout = 10_000) {
      const timer = AbortSignal.timeout(timeout);
      return Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer.addEventListener(
            "abort",
            () => {
              reject(new Error("ConPTY exit timed out"));
            },
            {
              once: true,
            },
          );
        }),
      ]);
    },
    async waitForQuiet(quiet = 200, timeout = 10_000) {
      let changed = Date.now();
      let length = output.length;
      await until(
        () => {
          if (length !== output.length) {
            length = output.length;
            changed = Date.now();
          }
          return Date.now() - changed >= quiet;
        },
        timeout,
        "ConPTY did not become quiet",
      );
    },
    waitForText: (text, timeout = 10_000) =>
      until(() => output.includes(text), timeout, `ConPTY did not render ${text}`),
    write(text) {
      child.stdin.write(text);
    },
  };
}
