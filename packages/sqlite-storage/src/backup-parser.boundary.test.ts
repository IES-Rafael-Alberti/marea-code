import { describe, expect, it } from "vitest";

import { SQLITE_BACKUP_FORMAT, SqliteStorageError } from "./contracts.js";
import { calculateBackupDigest, parseBackup } from "./backup-parser.boundary.js";

type BackupBoundaryValue = boolean | number | object | string | undefined;

function expectInvalid(value: BackupBoundaryValue, maxBackupBytes = 3): void {
  expect(() => parseBackup(value, 1, maxBackupBytes)).toThrow(
    expect.objectContaining<Partial<SqliteStorageError>>({
      code: "backup-invalid",
      message: "The SQLite backup is invalid.",
      name: "SqliteStorageError",
    }),
  );
}

describe("backup parser boundary", () => {
  it("validates and returns the same owned byte snapshot", () => {
    const source = Uint8Array.from([1, 2, 3]);
    const sha256 = calculateBackupDigest(source);
    const parsed = parseBackup(
      { bytes: source, format: SQLITE_BACKUP_FORMAT, schemaVersion: 1, sha256 },
      1,
      source.byteLength,
    );

    expect(parsed.bytes).not.toBe(source);
    expect(parsed.bytes).toEqual(Uint8Array.from([1, 2, 3]));
    expect(parsed.schemaVersion).toBe(1);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(calculateBackupDigest(parsed.bytes)).toBe(sha256);
    source[0] = 9;
    expect(parsed.bytes).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("accepts every known positive integer schema version for staged verification", () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const artifact = { bytes, format: SQLITE_BACKUP_FORMAT, sha256: calculateBackupDigest(bytes) };
    for (const schemaVersion of [1, 2, 3]) {
      expect(parseBackup({ ...artifact, schemaVersion }, 3, 3).schemaVersion).toBe(schemaVersion);
    }
    for (const schemaVersion of [0, -1, 1.5, 4, "1", undefined, NaN, Infinity]) {
      expect(() => parseBackup({ ...artifact, schemaVersion }, 3, 3)).toThrow(
        "The SQLite backup is invalid.",
      );
    }
  });

  it("rejects a digest that does not describe the owned snapshot", () => {
    const source = Uint8Array.from([1, 2, 3]);
    expectInvalid({
      bytes: source,
      format: SQLITE_BACKUP_FORMAT,
      schemaVersion: 1,
      sha256: calculateBackupDigest(Uint8Array.from([9, 2, 3])),
    });
  });

  it("rejects primitive artifacts and an independently valid oversized snapshot", () => {
    for (const value of [undefined, true, "backup", 3]) {
      expectInvalid(value);
    }
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    expectInvalid(
      {
        bytes,
        format: SQLITE_BACKUP_FORMAT,
        schemaVersion: 1,
        sha256: calculateBackupDigest(bytes),
      },
      3,
    );
  });
});
