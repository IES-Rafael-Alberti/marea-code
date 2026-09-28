import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteStorageError } from "./contracts.js";
import { canonicalizeDatabasePath } from "./database-path.boundary.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "marea-sqlite-path-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function expectInvalid(databasePath: string): void {
  expect(() => canonicalizeDatabasePath(databasePath)).toThrow(
    expect.objectContaining<Partial<SqliteStorageError>>({
      code: "invalid-database-path",
      message: "The SQLite database path must be an absolute persistent file path.",
      name: "SqliteStorageError",
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("SQLite database path boundary", () => {
  it("canonicalizes dot segments and symlinked parent aliases to one identity", () => {
    const root = temporaryDirectory();
    const realParent = join(root, "real");
    const parentAlias = join(root, "alias");
    mkdirSync(realParent);
    symlinkSync(realParent, parentAlias);
    const canonical = canonicalizeDatabasePath(join(realParent, "marea.sqlite"));

    expect(canonicalizeDatabasePath(join(root, "real", "..", "real", "marea.sqlite"))).toBe(
      canonical,
    );
    expect(canonicalizeDatabasePath(join(parentAlias, "marea.sqlite"))).toBe(canonical);
  });

  it("accepts a missing target or a single-link regular database file", () => {
    const root = temporaryDirectory();
    const canonicalRoot = realpathSync.native(root);
    const missing = join(root, "missing.sqlite");
    expect(canonicalizeDatabasePath(missing)).toBe(join(canonicalRoot, "missing.sqlite"));

    const existing = join(root, "existing.sqlite");
    writeFileSync(existing, "database");
    expect(canonicalizeDatabasePath(existing)).toBe(join(canonicalRoot, "existing.sqlite"));
  });

  it("rejects non-file, symlink, and hard-linked targets", () => {
    const root = temporaryDirectory();
    const directoryTarget = join(root, "directory.sqlite");
    mkdirSync(directoryTarget);
    expectInvalid(directoryTarget);

    const source = join(root, "source.sqlite");
    writeFileSync(source, "database");
    const symlink = join(root, "symlink.sqlite");
    symlinkSync(source, symlink);
    expectInvalid(symlink);

    const hardLink = join(root, "hard-link.sqlite");
    linkSync(source, hardLink);
    expectInvalid(source);
    expectInvalid(hardLink);
  });

  it("rejects malformed, oversized, and non-persistent paths before filesystem access", () => {
    for (const path of [
      "",
      "relative.sqlite",
      ":memory:",
      "/",
      "/tmp/bad\0name.sqlite",
      `/${"a".repeat(256)}`,
      `/${"a/".repeat(2048)}file.sqlite`,
      `/${"é".repeat(2048)}`,
      null as never,
    ]) {
      expectInvalid(path);
    }
  });

  it("maps missing-parent filesystem diagnostics to a safe path error", () => {
    const root = temporaryDirectory();
    expectInvalid(join(root, "absent", "marea.sqlite"));
  });

  it("rejects oversized text before encoding while allowing the exact text boundary", () => {
    const NativeTextEncoder = TextEncoder;
    const encode = vi.fn((value: string) => new NativeTextEncoder().encode(value));
    vi.stubGlobal(
      "TextEncoder",
      class TextEncoderMock {
        public encode(value: string): Uint8Array {
          return encode(value);
        }
      },
    );

    expectInvalid(`/${"a/".repeat(2048)}x`);
    expect(encode).not.toHaveBeenCalled();

    const exactBoundary = `/${"a/".repeat(2046)}a/x`;
    expect(exactBoundary).toHaveLength(4096);
    expectInvalid(exactBoundary);
    expect(encode).toHaveBeenCalled();
  });

  it("allows a basename exactly at the portable byte limit", () => {
    const root = temporaryDirectory();
    const name = "a".repeat(255);

    expect(canonicalizeDatabasePath(join(root, name))).toMatch(/a{255}$/u);
  });

  it("enforces encoded path and basename limits independently at exact boundaries", () => {
    const root = temporaryDirectory();
    const path = join(root, "database.sqlite");
    let pathBytes = 4096;
    let basenameBytes = 255;
    vi.stubGlobal(
      "TextEncoder",
      class TextEncoderMock {
        public encode(value: string): Uint8Array {
          return new Uint8Array(value === path ? pathBytes : basenameBytes);
        }
      },
    );

    expect(canonicalizeDatabasePath(path)).toMatch(/database\.sqlite$/u);
    pathBytes = 4097;
    expectInvalid(path);
    pathBytes = 4096;
    basenameBytes = 256;
    expectInvalid(path);
  });
});
