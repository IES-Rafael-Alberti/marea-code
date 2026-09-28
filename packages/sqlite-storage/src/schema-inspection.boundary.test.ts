import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageError } from "./contracts.js";

const native = vi.hoisted(() => {
  const get = vi.fn<() => { user_version: number } | null>();
  const finalize = vi.fn();
  const close = vi.fn();
  const prepare = vi.fn(() => ({ get, finalize }));
  const open = vi.fn<(path: string, options: object) => void>();
  class Database {
    constructor(path: string, options: object) {
      open(path, options);
    }
    prepare = prepare;
    close = close;
  }
  return { Database, get, finalize, close, prepare, open };
});
vi.mock("bun:sqlite", () => ({ Database: native.Database }));
const files = vi.hoisted(() => ({ readSync: vi.fn(), closeSync: vi.fn() }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  files.readSync.mockImplementation(actual.readSync);
  files.closeSync.mockImplementation(actual.closeSync);
  return { ...actual, readSync: files.readSync, closeSync: files.closeSync };
});
import { inspectSqliteSchemaVersion } from "./schema-inspection.boundary.js";

let root: string;
let path: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = realpathSync(mkdtempSync(join(tmpdir(), "marea-schema-inspection-")));
  path = join(root, "fixture.sqlite");
  writeFileSync(path, "unchanged fixture");
  writeFileSync(`${path}-wal`, "");
  native.get.mockReturnValue({ user_version: 8 });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("read-only SQLite schema inspection", () => {
  it("uses only an existing read-only connection, returns the actual version and closes both handles", () => {
    for (const version of [0, 7, 8, 9]) {
      native.get.mockReturnValueOnce({ user_version: version });
      expect(inspectSqliteSchemaVersion({ databasePath: path })).toBe(version);
    }
    expect(native.open.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [path, { readonly: true, strict: true }]),
    );
    expect(native.prepare.mock.calls).toEqual(
      Array.from({ length: 4 }, () => ["PRAGMA user_version"]),
    );
    expect(native.get.mock.calls).toEqual([[], [], [], []]);
    expect(native.finalize.mock.calls).toEqual([[], [], [], []]);
    expect(native.close.mock.calls).toEqual([[true], [true], [true], [true]]);
    expect(readFileSync(path, "utf8")).toBe("unchanged fixture");
  });
  it("opens a connection whenever a WAL or rollback journal may hold newer state", () => {
    rmSync(`${path}-wal`);
    writeFileSync(`${path}-journal`, "");
    native.get.mockReturnValueOnce({ user_version: 5 });
    expect(inspectSqliteSchemaVersion({ databasePath: path })).toBe(5);
    expect(native.open).toHaveBeenCalledTimes(1);
  });
  it("validates the persistent path before attempting to open the driver", () => {
    expect(() => inspectSqliteSchemaVersion({ databasePath: ":memory:" })).toThrow(
      SqliteStorageError,
    );
    expect(native.open).not.toHaveBeenCalled();
  });
  it("sanitizes open, query, row and cleanup failures and closes every acquired handle", () => {
    for (const stage of ["open", "prepare", "get", "empty", "finalize", "close"] as const) {
      vi.clearAllMocks();
      const fail = () => {
        throw new Error("private SQL/path");
      };
      if (stage === "empty") native.get.mockReturnValueOnce(null);
      else native[stage].mockImplementationOnce(fail);
      expect(() => inspectSqliteSchemaVersion({ databasePath: path })).toThrow(
        stage === "empty"
          ? new SqliteStorageError("schema-mismatch", "The SQLite schema version is unavailable.")
          : new SqliteStorageError(
              "database-unavailable",
              "The SQLite schema could not be inspected.",
            ),
      );
      expect(native.close).toHaveBeenCalledTimes(stage === "open" ? 0 : 1);
      expect(native.finalize).toHaveBeenCalledTimes(
        stage === "open" || stage === "prepare" ? 0 : 1,
      );
    }
  });
});

describe("SQLite schema inspection without WAL or journal sidecars", () => {
  const header = (magic: string, version: number, bytes = 100) => {
    const content = Buffer.alloc(bytes);
    content.write(magic, 0, "latin1");
    if (bytes >= 64) content.writeInt32BE(version, 60);
    return content;
  };
  const inspectFile = (content: Buffer | string) => {
    rmSync(`${path}-wal`, { force: true });
    writeFileSync(path, content);
    return () => inspectSqliteSchemaVersion({ databasePath: path });
  };
  const unavailable = new SqliteStorageError(
    "database-unavailable",
    "The SQLite schema could not be inspected.",
  );

  it("reads the committed user version from the main file header without a connection", () => {
    for (const version of [0, 8, 9, -1, 0x01020304])
      expect(inspectFile(header("SQLite format 3\0", version, 4096))()).toBe(version);
    expect(inspectFile("")()).toBe(0);
    expect(native.open).not.toHaveBeenCalled();
    expect(files.closeSync).toHaveBeenCalledTimes(6);
    files.readSync.mockImplementationOnce(() => {
      throw new Error("private read failure");
    });
    expect(inspectFile(header("SQLite format 3\0", 9))).toThrow(
      new SqliteStorageError("database-unavailable", "The SQLite schema could not be inspected."),
    );
    expect(files.closeSync).toHaveBeenCalledTimes(7);
  });

  it("refuses files that are not SQLite databases or no longer exist", () => {
    for (const content of [
      "short",
      header("SQLite format 3\0", 9, 99),
      header("SQLite format 4\0", 9),
      header("SQLite format 3!", 9),
    ])
      expect(inspectFile(content)).toThrow(unavailable);
    rmSync(path);
    expect(() => inspectSqliteSchemaVersion({ databasePath: path })).toThrow(unavailable);
    expect(native.open).not.toHaveBeenCalled();
  });
});
