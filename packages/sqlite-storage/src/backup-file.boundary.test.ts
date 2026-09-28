import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { backupFileInstaller } from "./backup-file.boundary.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "marea-sqlite-file-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("backup file installation", () => {
  it("validates a durable same-directory staging file before no-clobber installation", () => {
    const directory = createTemporaryDirectory();
    const destination = join(directory, "restored.sqlite");
    const bytes = Uint8Array.from([1, 2, 3]);
    let stagedPath = "";

    backupFileInstaller.installNew(destination, bytes, (candidate) => {
      stagedPath = candidate;
      expect(existsSync(destination)).toBe(false);
      expect(readFileSync(candidate)).toEqual(Buffer.from(bytes));
      writeFileSync(`${candidate}-wal`, "temporary");
      writeFileSync(`${candidate}-shm`, "temporary");
    });

    expect(readFileSync(destination)).toEqual(Buffer.from(bytes));
    expect(existsSync(stagedPath)).toBe(false);
    expect(existsSync(`${stagedPath}-wal`)).toBe(false);
    expect(existsSync(`${stagedPath}-shm`)).toBe(false);
  });

  it("never overwrites an existing destination", () => {
    const directory = createTemporaryDirectory();
    const destination = join(directory, "restored.sqlite");
    writeFileSync(destination, "original");

    expect(() => {
      backupFileInstaller.installNew(destination, Uint8Array.from([1]), () => undefined);
    }).toThrow();
    expect(readFileSync(destination, "utf8")).toBe("original");
  });

  it("removes staging artifacts when validation rejects the backup", () => {
    const directory = createTemporaryDirectory();
    const destination = join(directory, "restored.sqlite");
    let stagedPath = "";

    expect(() => {
      backupFileInstaller.installNew(destination, Uint8Array.from([1]), (candidate) => {
        stagedPath = candidate;
        throw new Error("invalid backup");
      });
    }).toThrow("invalid backup");
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(stagedPath)).toBe(false);
  });

  it("fails without creating a destination when the parent directory is absent", () => {
    const directory = createTemporaryDirectory();
    const absent = join(directory, "absent");
    const destination = join(absent, "restored.sqlite");
    expect(existsSync(absent)).toBe(false);

    expect(() => {
      backupFileInstaller.installNew(destination, Uint8Array.from([1]), () => undefined);
    }).toThrow();
    expect(existsSync(destination)).toBe(false);
  });
});
