import { describe, expect, it, type Mock, vi } from "vitest";

import { runCli, type CliPorts } from "./cli.js";
import type { StudentTuiCopy, StudentTuiOutcome, StudentTuiSession } from "./contracts.js";
import { StudentTuiStartupError } from "./startup-error.js";

function session(outcome: StudentTuiOutcome): StudentTuiSession {
  return {
    appendText: vi.fn(),
    cancellation: new Promise<void>(() => undefined),
    close: vi.fn(),
    complete: vi.fn(),
    outcome: Promise.resolve(outcome),
    snapshot: vi.fn(),
  };
}

const copy: StudentTuiCopy = {
  controls: "keys",
  emptyResponse: "empty",
  errors: {
    nonInteractive: "terminal required",
    rendererFailed: "renderer failed",
    unexpected: "unexpected failure",
  },
  statuses: { cancelled: "x", complete: "d", ready: "r", streaming: "s" },
  title: "title",
};

function ports(start: CliPorts["start"]): CliPorts & {
  writeError: Mock<(message: string) => void>;
  writeOutput: Mock<(message: string) => void>;
} {
  return {
    start,
    writeError: vi.fn<(message: string) => void>(),
    writeOutput: vi.fn<(message: string) => void>(),
  };
}

describe("runCli", () => {
  it("uses the default process output ports in smoke mode", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli(["--smoke"], copy)).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith("marea-student-tui smoke ok: complete/ok\n");
    write.mockRestore();
  });

  it("uses the default startup and error ports outside a TTY", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runCli([], copy)).resolves.toBe(2);
    expect(write).toHaveBeenCalledWith("terminal required\n");
    write.mockRestore();
  });

  it("runs deterministic smoke mode without starting a terminal", async () => {
    const target = ports(vi.fn());

    await expect(runCli(["--smoke"], copy, target)).resolves.toBe(0);
    expect(target.start).not.toHaveBeenCalled();
    expect(target.writeOutput).toHaveBeenCalledWith("marea-student-tui smoke ok: complete/ok");
    expect(target.writeError).not.toHaveBeenCalled();
  });

  it("returns the session outcome", async () => {
    const target = ports(() => Promise.resolve(session({ exitCode: 130, reason: "sigint" })));

    await expect(runCli([], copy, target)).resolves.toBe(130);
    expect(target.writeError).not.toHaveBeenCalled();
  });

  it("reports startup errors without native details", async () => {
    const target = ports(() => Promise.reject(new StudentTuiStartupError("NON_INTERACTIVE")));

    await expect(runCli([], copy, target)).resolves.toBe(2);
    expect(target.writeError).toHaveBeenCalledWith("terminal required");
  });

  it("reports unexpected failures with a stable message", async () => {
    const target = ports(() => Promise.reject(new Error("private detail")));

    await expect(runCli([], copy, target)).resolves.toBe(1);
    expect(target.writeError).toHaveBeenCalledWith("unexpected failure");
  });

  it("uses localized renderer startup copy", async () => {
    const target = ports(() => Promise.reject(new StudentTuiStartupError("RENDERER_FAILED")));

    await expect(runCli([], copy, target)).resolves.toBe(1);
    expect(target.writeError).toHaveBeenCalledWith("renderer failed");
  });
});
