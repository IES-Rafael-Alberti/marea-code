import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";

/** Commands are explicit effects, with a bounded lifetime and output. */
export function runProjectCommand(
  root: string,
  command: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const receive = (text: string) => {
      const remaining = 16_384 - output.length;
      output += text.slice(0, remaining);
      truncated ||= text.length > remaining;
    };
    const stdout = new StringDecoder();
    const stderr = new StringDecoder();
    child.stdout.on("data", (chunk: Buffer) => {
      receive(stdout.write(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      receive(stderr.write(chunk));
    });
    const kill = (kind: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, kind);
      } catch {
        child.kill(kind);
      }
    };
    const stop = () => {
      stopped = true;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        kill("SIGKILL");
      }, 1000);
    };
    signal.addEventListener("abort", stop, { once: true });
    const deadline = setTimeout(stop, 30_000);
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      receive(stdout.end());
      receive(stderr.end());
      // Do not leave detached descendants alive after the shell exits.
      kill("SIGKILL");
      cleanup();
      resolve(JSON.stringify({ exitCode: code, stopped, truncated, output }));
    });
    if (signal.aborted) stop();
  });
}
