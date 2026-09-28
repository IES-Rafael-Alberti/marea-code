import { describe, expect, it, vi } from "vitest";

const fileSystem = vi.hoisted(() => ({
  lstatSync: vi.fn(() => ({
    isFile: () => false,
    isSymbolicLink: () => false,
    nlink: 1,
  })),
  realpathNative: vi.fn((path: string) => path),
}));

vi.mock("node:fs", () => ({
  lstatSync: fileSystem.lstatSync,
  realpathSync: Object.assign(vi.fn(), { native: fileSystem.realpathNative }),
}));

import { SqliteStorageError } from "./contracts.js";
import { canonicalizeDatabasePath } from "./database-path.boundary.js";

describe("database path filesystem boundary", () => {
  it("rejects a single-link non-file target", () => {
    expect(() => canonicalizeDatabasePath("/data/marea.socket")).toThrow(
      expect.objectContaining<Partial<SqliteStorageError>>({
        code: "invalid-database-path",
        message: "The SQLite database path must be an absolute persistent file path.",
        name: "SqliteStorageError",
      }),
    );
  });
});
