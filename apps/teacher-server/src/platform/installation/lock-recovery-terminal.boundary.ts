import type { LockRecoveryDependencies, LockRecoveryTerminal } from "./abandoned-lock-recovery.js";

export interface TerminalInput {
  readonly isTTY?: boolean;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** A line-reading terminal over a readable input; interrupts and end of input answer nothing. */
export function streamTerminal(
  input: TerminalInput,
  output: { readonly isTTY?: boolean; write(text: string): unknown },
  signals: SignalSource,
): LockRecoveryTerminal {
  return Object.freeze({
    interactive: input.isTTY === true && output.isTTY === true,
    write: (text: string) => {
      output.write(text);
    },
    readLine: () =>
      new Promise<string | undefined>((resolve) => {
        let line = "";
        const finish = (answer: string | undefined) => {
          input.removeListener("data", onData);
          input.removeListener("end", onEnd);
          signals.removeListener("SIGINT", onEnd);
          signals.removeListener("SIGTERM", onEnd);
          input.pause();
          resolve(answer);
        };
        const onData = (chunk: Buffer) => {
          line += chunk.toString("utf8");
          const end = line.indexOf("\n");
          if (end >= 0) finish(line.slice(0, end));
        };
        const onEnd = () => {
          finish(undefined);
        };
        input.on("data", onData);
        input.on("end", onEnd);
        // A previous question paused the input; a later one in the same process reads again.
        input.resume();
        signals.once("SIGINT", onEnd);
        signals.once("SIGTERM", onEnd);
      }),
  });
}

/** Whether a process exists; a process owned by another user also exists. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Lock recovery through the process's standard input and error streams. */
export function processLockRecovery(): LockRecoveryDependencies {
  return {
    terminal: streamTerminal(process.stdin, process.stderr, process),
    processExists,
  };
}
