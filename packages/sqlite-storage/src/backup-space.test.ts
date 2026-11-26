import { describe, expect, it } from "vitest";

import { assertBackupSpace, requiredBackupBytes } from "./backup-space.js";
import { SqliteStorageError } from "./contracts.js";
import { ReadyDatabase } from "../test-support/storage-fakes.js";

const MEBIBYTE = 1_048_576;

function database(megabytes: number): ReadyDatabase {
  const fake = new ReadyDatabase();
  fake.pageSize = 4096;
  fake.pageCount = (megabytes * MEBIBYTE) / 4096;
  return fake;
}

describe("backup space", () => {
  it("requires the database plus a margin of at least 64 MiB", () => {
    expect(requiredBackupBytes(database(100))).toBe(100 * MEBIBYTE + 64 * MEBIBYTE);
  });

  it("requires a margin of ten percent once that exceeds 64 MiB", () => {
    expect(requiredBackupBytes(database(1000))).toBe(1100 * MEBIBYTE);
  });

  it("requires only the margin when the database size cannot be read", () => {
    const unreadable = new ReadyDatabase();
    unreadable.readOne = () => undefined;
    expect(requiredBackupBytes(unreadable)).toBe(64 * MEBIBYTE);
  });

  it("accepts a volume with exactly the required space", () => {
    expect(() => {
      assertBackupSpace(database(100), { freeBytes: () => 164 * MEBIBYTE }, "/backups");
    }).not.toThrow();
  });

  it("asks the volume of the destination directory", () => {
    const asked: string[] = [];
    assertBackupSpace(
      database(1),
      {
        freeBytes: (directory) => {
          asked.push(directory);
          return 10_000 * MEBIBYTE;
        },
      },
      "/backups",
    );
    expect(asked).toEqual(["/backups"]);
  });

  it("names the required and the available space when the volume is too small", () => {
    let failure: Error | undefined;
    try {
      assertBackupSpace(database(100), { freeBytes: () => 163 * MEBIBYTE + 5 }, "/backups");
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(SqliteStorageError);
    expect(failure).toMatchObject({
      code: "insufficient-disk-space",
      message: "The SQLite backup needs 164 MiB of free disk space but only 163 MiB is available.",
    });
  });

  it("leaves an unreadable volume to the copy itself", () => {
    expect(() => {
      assertBackupSpace(database(100), { freeBytes: () => undefined }, "/backups");
    }).not.toThrow();
  });
});
