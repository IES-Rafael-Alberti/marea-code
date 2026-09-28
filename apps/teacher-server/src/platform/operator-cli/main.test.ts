import { afterEach, describe, expect, it, vi } from "vitest";
import { runMain, writeOutput } from "./main.js";
import type { OperatorCliDependencies } from "./cli.js";

const mocks = vi.hoisted(() => ({
  run: vi.fn().mockResolvedValue(4),
  acquire: vi.fn(),
  compose: vi.fn(),
  write: vi.fn(),
  recovery: { name: "lock recovery" },
  recovering: vi.fn(() => "recovering acquire"),
}));
vi.mock("../installation/abandoned-lock-recovery.js", () => ({
  acquireWithLockRecovery: mocks.recovering,
}));
vi.mock("../installation/lock-recovery-terminal.boundary.js", () => ({
  processLockRecovery: () => mocks.recovery,
}));
vi.mock("./cli.js", () => ({ runOperatorCli: mocks.run }));
vi.mock("./composition.js", () => ({ composeInstallation: mocks.compose }));
vi.mock("./installation-lock.js", () => ({ acquireInstallation: mocks.acquire }));
vi.mock("node:fs", async (load) => ({
  ...(await load<typeof import("node:fs")>()),
  writeSync: mocks.write,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("production CLI wiring and writes", () => {
  it("writes all UTF-8 bytes including partial writes and does nothing for empty output", () => {
    const bytes = Buffer.from("éx\n");
    mocks.write.mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(1);
    writeOutput(9, "éx\n");
    expect(mocks.write.mock.calls).toEqual([
      [9, bytes, 0, 4],
      [9, bytes, 1, 3],
      [9, bytes, 3, 1],
    ]);
    writeOutput(9, "");
    expect(mocks.write).toHaveBeenCalledTimes(3);
  });
  it("does not claim success on OS errors or a write that makes no progress", () => {
    for (const written of [0, -1]) {
      mocks.write.mockReturnValueOnce(written);
      expect(() => {
        writeOutput(1, "text");
      }).toThrow("output-failed");
    }
    const error = new Error("private broken pipe");
    mocks.write.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => {
      writeOutput(1, "text");
    }).toThrow(error);
    expect(mocks.write).toHaveBeenCalledTimes(3);
  });
  it("wires real ports, exact argv, standard descriptors, private prompt and UTC clock", async () => {
    const argv = ["--installation", "/private/test", "center", "create"];
    expect(await runMain(argv)).toBe(4);
    const [received, deps] = mocks.run.mock.calls[0] as [string[], OperatorCliDependencies];
    expect(received).toBe(argv);
    expect(mocks.recovering).toHaveBeenCalledWith(mocks.acquire, mocks.recovery);
    expect(deps.acquire).toBe("recovering acquire");
    expect(deps.compose).toBe(mocks.compose);
    expect(deps.stdin).toBe(process.stdin);
    expect(deps.signals).toBe(process);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T01:02:03.004Z"));
    try {
      expect(deps.now()).toBe("2026-09-13T01:02:03.004Z");
    } finally {
      vi.useRealTimers();
    }
    for (const [fd, write] of [
      [1, deps.stdout],
      [2, deps.stderr],
      [2, deps.prompt],
    ] as const) {
      mocks.write.mockClear();
      mocks.write.mockReturnValueOnce(10);
      await write("Password: ");
      expect(mocks.write).toHaveBeenCalledTimes(1);
      expect(mocks.write).toHaveBeenLastCalledWith(fd, Buffer.from("Password: "), 0, 10);
    }
    const old = process.argv;
    process.argv = ["runtime", "executable", ...argv];
    try {
      expect(await runMain()).toBe(4);
      expect(mocks.run.mock.calls[1]?.[0]).toEqual(argv);
    } finally {
      process.argv = old;
    }
  });
  it("the actual root entry awaits main and assigns its result to exitCode", async () => {
    const old = process.exitCode;
    try {
      mocks.run.mockResolvedValueOnce(6);
      await import("../../../cli-entry.js");
      expect(process.exitCode).toBe(6);
      expect(mocks.run).toHaveBeenCalledTimes(1);
    } finally {
      process.exitCode = old;
    }
  });
});
