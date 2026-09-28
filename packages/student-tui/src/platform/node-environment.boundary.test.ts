import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeEnvironment, type NodeProcessPort } from "./node-environment.boundary.js";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("createNodeEnvironment", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ] as const)("requires both TTY streams: %s/%s", (stdinIsTty, stdoutIsTty, interactive) => {
    const nodeProcess: NodeProcessPort = {
      stdinIsTty,
      stdoutIsTty,
      off: vi.fn(),
      on: vi.fn(),
      setExitCode: vi.fn(),
    };

    expect(createNodeEnvironment(nodeProcess).interactive).toBe(interactive);
  });

  it("reflects the terminal and writes an exit code", () => {
    const environment = createNodeEnvironment();

    expect(environment.interactive).toBe(process.stdin.isTTY && process.stdout.isTTY);
    environment.setExitCode(143);
    expect(process.exitCode).toBe(143);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "subscribes and unsubscribes from %s without delivering it",
    (signal) => {
      const on = vi.spyOn(process, "on");
      const off = vi.spyOn(process, "off");
      const handler = vi.fn();
      const environment = createNodeEnvironment();

      const remove = environment.signals.subscribe(signal, handler);
      remove();

      expect(on).toHaveBeenCalledWith(signal, handler);
      expect(off).toHaveBeenCalledWith(signal, handler);
      on.mockRestore();
      off.mockRestore();
    },
  );
});
