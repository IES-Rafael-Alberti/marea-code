import { StringDecoder } from "node:string_decoder";
import { spawn, spawnSync } from "node:child_process";
import { win32 } from "node:path";
import {
  COMMAND_DEADLINE_MS,
  COMMAND_OUTPUT_HEAD_CHARACTERS,
  COMMAND_OUTPUT_TAIL_CHARACTERS,
} from "./command-limits.js";

/** Commands are explicit effects, with a bounded lifetime and output (head and tail are kept). */
export function runProjectCommand(
  root: string,
  command: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const systemDirectory = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const child = spawn(
      windows ? win32.join(systemDirectory, "cmd.exe") : "/bin/sh",
      windows ? ["/d", "/s", "/c", command] : ["-c", command],
      {
        cwd: root,
        detached: !windows,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let head = "";
    let tail = "";
    let omitted = 0;
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const receive = (text: string) => {
      const headPart = text.slice(0, COMMAND_OUTPUT_HEAD_CHARACTERS - head.length);
      head += headPart;
      tail += text.slice(headPart.length);
      const kept = tail.slice(-COMMAND_OUTPUT_TAIL_CHARACTERS);
      omitted += tail.length - kept.length;
      tail = kept;
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
        if (windows) {
          const result = spawnSync(
            win32.join(systemDirectory, "taskkill.exe"),
            ["/pid", String(child.pid), "/T", "/F"],
            { stdio: "ignore", windowsHide: true, timeout: 5_000 },
          );
          if (result.status !== 0) child.kill(kind);
          return;
        }
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
    const deadline = setTimeout(stop, COMMAND_DEADLINE_MS);
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
      // Best-effort process-tree cleanup; commands still have the user's OS permissions.
      kill("SIGKILL");
      cleanup();
      const output =
        omitted === 0 ? head + tail : `${head}\n… ${String(omitted)} characters omitted …\n${tail}`;
      resolve(JSON.stringify({ exitCode: code, stopped, truncated: omitted > 0, output }));
    });
    if (signal.aborted) stop();
  });
}
