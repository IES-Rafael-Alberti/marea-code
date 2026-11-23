import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createLocalStateRecovery,
  type LocalStateRecoveryFileSystem,
} from "./local-state-recovery.boundary.js";

function filesystem() {
  return {
    inspect: vi.fn<LocalStateRecoveryFileSystem["inspect"]>(() => Promise.resolve(null)),
    list: vi.fn<LocalStateRecoveryFileSystem["list"]>(() => Promise.resolve([])),
    move: vi.fn<LocalStateRecoveryFileSystem["move"]>(() => Promise.resolve(undefined)),
    remove: vi.fn<LocalStateRecoveryFileSystem["remove"]>(() => Promise.resolve(undefined)),
    secureDirectory: vi.fn<LocalStateRecoveryFileSystem["secureDirectory"]>(() =>
      Promise.resolve(undefined),
    ),
  };
}

describe("local recovery validation boundaries", () => {
  it("continues after missing temporary files and removes the exact age boundary", async () => {
    const fs = filesystem();
    vi.mocked(fs.list).mockResolvedValueOnce(["gone.tmp", "keep.tmp.backup", "old.next"]);
    vi.mocked(fs.inspect)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ modifiedAt: 0, regularFile: true });
    const recovery = createLocalStateRecovery({
      filesystem: fs,
      stateDirectory: "/state",
      now: () => new Date(3_600_000),
    });
    await recovery.prepare();
    expect(fs.inspect).toHaveBeenCalledTimes(2);
    expect(fs.remove).toHaveBeenCalledExactlyOnceWith(join("/state", "old.next"));
    expect(recovery.report().staleTemporaryFiles).toBe(1);
  });

  it("secures the top-level quarantine only once for a root state file", async () => {
    const fs = filesystem();
    const recovery = createLocalStateRecovery({
      filesystem: fs,
      stateDirectory: "/state",
      nextQuarantineId: () => "id",
      now: () => new Date(0),
      probes: [
        {
          file: "session.json",
          reason: "session",
          load: () => Promise.reject(new SyntaxError("damaged")),
        },
      ],
    });
    await recovery.prepare();
    const directory = join("/state", "quarantine", "1970-01-01T00.00.00.000Z-id");
    expect(fs.secureDirectory).toHaveBeenCalledExactlyOnceWith(directory);
    expect(fs.move).toHaveBeenCalledExactlyOnceWith(
      join("/state", "session.json"),
      join(directory, "session.json"),
    );
  });

  it("reuses its quarantine identity and moves only matching temporary siblings", async () => {
    const fs = filesystem();
    const nextQuarantineId = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");
    vi.mocked(fs.list).mockResolvedValueOnce([
      "checkpoints.bin.a.tmp",
      "checkpoints.bin.b.next",
      "checkpoints.bin.tmp.backup",
      "unrelated.tmp",
    ]);
    vi.mocked(fs.inspect).mockResolvedValue({ modifiedAt: 0, regularFile: true });
    const recovery = createLocalStateRecovery({
      filesystem: fs,
      stateDirectory: "/state",
      nextQuarantineId,
      now: () => new Date(0),
    });
    await recovery.quarantineCheckpointState();
    await recovery.quarantineCheckpointState();
    const quarantine = join("/state", "quarantine", "1970-01-01T00.00.00.000Z-first");
    expect(nextQuarantineId).toHaveBeenCalledTimes(1);
    expect(fs.secureDirectory.mock.calls).toEqual([
      [quarantine],
      [join(quarantine, "agent")],
      [join(quarantine, "agent")],
    ]);
    expect(fs.move.mock.calls).toEqual(
      ["checkpoints.bin", "checkpoints.bin.a.tmp", "checkpoints.bin.b.next", "checkpoints.bin"].map(
        (name) => [join("/state", "agent", name), join(quarantine, "agent", name)],
      ),
    );
    expect(fs.inspect).toHaveBeenCalledTimes(2);
  });

  it.each([
    "other.timeout",
    "!private-fs.timeout",
    "private-fs.!timeout",
    "private-fs.timeout!",
    { toString: () => "private-fs.timeout" },
  ])("wraps invalid or unrelated diagnostic codes: %#", async (diagnosticCode) => {
    const fs = filesystem();
    const failure = Object.assign(new Error("private"), { diagnosticCode });
    vi.mocked(fs.secureDirectory).mockRejectedValue(failure);
    const recovery = createLocalStateRecovery({ filesystem: fs, stateDirectory: "/state" });
    await expect(recovery.quarantineCheckpointState()).rejects.toMatchObject({
      name: "LocalStateQuarantineError",
      diagnosticCode: "local-state.quarantine-failed",
      cause: failure,
    });
  });

  it("does not trust diagnostic codes on non-Error rejections", async () => {
    const fs = filesystem();
    const failure = { diagnosticCode: "private-fs.timeout" };
    vi.mocked(fs.secureDirectory).mockRejectedValue(failure);
    const recovery = createLocalStateRecovery({ filesystem: fs, stateDirectory: "/state" });
    await expect(recovery.quarantineCheckpointState()).rejects.toMatchObject({
      name: "LocalStateQuarantineError",
      cause: failure,
    });
  });
});
