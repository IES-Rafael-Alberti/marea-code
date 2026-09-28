import { beforeEach, describe, expect, it, vi } from "vitest";

const fileSystem = vi.hoisted(() => ({
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  linkSync: vi.fn(),
  openSync: vi.fn(() => 7),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => fileSystem);

import { backupFileInstaller } from "./backup-file.boundary.js";

describe("backup file failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves a write failure when descriptor cleanup also fails", () => {
    fileSystem.writeFileSync.mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    fileSystem.closeSync.mockImplementationOnce(() => {
      throw new Error("close failed");
    });

    expect(() => {
      backupFileInstaller.installNew("/data/restore.sqlite", Uint8Array.from([1]), () => undefined);
    }).toThrow("write failed");
    expect(fileSystem.closeSync).toHaveBeenCalledWith(7);
    expect(fileSystem.linkSync).not.toHaveBeenCalled();
    expect(fileSystem.unlinkSync).toHaveBeenCalledTimes(3);
  });

  it("reports a close failure after a successful durable write", () => {
    fileSystem.closeSync.mockImplementationOnce(() => {
      throw new Error("close failed");
    });

    expect(() => {
      backupFileInstaller.installNew("/data/restore.sqlite", Uint8Array.from([1]), () => undefined);
    }).toThrow("close failed");
    expect(fileSystem.fsyncSync).toHaveBeenCalledWith(7);
    expect(fileSystem.linkSync).not.toHaveBeenCalled();
  });

  it("does not turn best-effort cleanup into a restore failure", () => {
    fileSystem.unlinkSync.mockImplementation(() => {
      throw new Error("cleanup failed");
    });

    expect(() => {
      backupFileInstaller.installNew("/data/restore.sqlite", Uint8Array.from([1]), () => undefined);
    }).not.toThrow();
    expect(fileSystem.linkSync).toHaveBeenCalledOnce();
  });
});
