import type { SignalSource, StudentTuiEnvironment, SupportedSignal } from "../contracts.js";

export interface NodeProcessPort {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  off(signal: SupportedSignal, handler: () => void): void;
  on(signal: SupportedSignal, handler: () => void): void;
  setExitCode(code: number): void;
}

const NODE_PROCESS: NodeProcessPort = Object.freeze({
  stdinIsTty: process.stdin.isTTY,
  stdoutIsTty: process.stdout.isTTY,
  off(signal: SupportedSignal, handler: () => void): void {
    if (signal === "SIGINT") process.off("SIGINT", handler);
    else process.off("SIGTERM", handler);
  },
  on(signal: SupportedSignal, handler: () => void): void {
    if (signal === "SIGINT") process.on("SIGINT", handler);
    else process.on("SIGTERM", handler);
  },
  setExitCode(code: number): void {
    process.exitCode = code;
  },
});

export function createNodeEnvironment(
  nodeProcess: NodeProcessPort = NODE_PROCESS,
): StudentTuiEnvironment {
  const signals: SignalSource = Object.freeze({
    subscribe(signal: SupportedSignal, handler: () => void): () => void {
      nodeProcess.on(signal, handler);
      return () => {
        nodeProcess.off(signal, handler);
      };
    },
  });

  return Object.freeze({
    interactive: nodeProcess.stdinIsTty && nodeProcess.stdoutIsTty,
    setExitCode(code: number): void {
      nodeProcess.setExitCode(code);
    },
    signals,
  });
}
