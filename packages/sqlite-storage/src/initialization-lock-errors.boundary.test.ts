import { beforeEach, describe, expect, it, vi } from "vitest";

const fileSystem = vi.hoisted(() => ({
  closeSync: vi.fn(),
  openSync: vi.fn(() => 7),
  unlinkSync: vi.fn(),
}));

vi.mock("node:fs", () => fileSystem);

import {
  initializationLockPath,
  isAlreadyExistsError,
  runWithInitializationFileLock,
} from "./initialization-lock.boundary.js";

describe("initialization lock descriptor failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes the acquired lock when descriptor close fails", () => {
    const databasePath = "/data/marea.sqlite";
    fileSystem.closeSync.mockImplementationOnce(() => {
      throw new Error("close failed");
    });

    expect(() => {
      runWithInitializationFileLock(databasePath, () => undefined);
    }).toThrow("close failed");
    expect(fileSystem.unlinkSync).toHaveBeenCalledWith(initializationLockPath(databasePath));
  });

  it("preserves the close failure when lock removal also fails", () => {
    fileSystem.closeSync.mockImplementationOnce(() => {
      throw new Error("close failed");
    });
    fileSystem.unlinkSync.mockImplementationOnce(() => {
      throw new Error("unlink failed");
    });

    expect(() => {
      runWithInitializationFileLock("/data/marea.sqlite", () => undefined);
    }).toThrow("close failed");
  });

  it("cleans up after an operation failure without obscuring it", () => {
    const operationFailure = new Error("operation failed");
    fileSystem.unlinkSync.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });

    expect(() => {
      runWithInitializationFileLock("/data/marea.sqlite", () => {
        throw operationFailure;
      });
    }).toThrow(operationFailure);
    expect(fileSystem.unlinkSync).toHaveBeenCalledOnce();
  });

  it("classifies only native Error objects carrying the contention code", () => {
    const contention = Object.assign(new Error("occupied"), { code: "EEXIST" });

    expect(isAlreadyExistsError(contention)).toBe(true);
    expect(isAlreadyExistsError(new Error("missing code"))).toBe(false);
    expect(isAlreadyExistsError({ code: "EEXIST" })).toBe(false);
  });
});
