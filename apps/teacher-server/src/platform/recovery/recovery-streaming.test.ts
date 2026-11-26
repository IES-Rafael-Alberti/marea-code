import { fstatSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hashRegularFile,
  verifyArtifactFiles,
  verifyArtifactFilesWithDatabase,
  verifyDatabaseFile,
} from "./artifact.boundary.js";
import { sha256Bytes } from "./manifest.boundary.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { recoveryManifest, writeRecoveryArtifact } from "./recovery-test-artifact.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";

const environment = startRecoveryTest("marea-recovery-streaming-");
const root = environment.root;

describe("streamed database hashing", () => {
  it("hashes a file of several chunks without any size cap and counts its bytes", () => {
    const bytes = Uint8Array.from({ length: 3 * 65_536 + 7 }, (_, index) => (index % 251) + 1);
    const path = join(root(), "multi-chunk");
    writeFileSync(path, bytes);
    expect(hashRegularFile(path, "bundle-database-invalid")).toEqual({
      sha256: sha256Bytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  });

  it("hashes an empty file", () => {
    const path = join(root(), "empty");
    writeFileSync(path, "");
    expect(hashRegularFile(path, "bundle-database-invalid")).toEqual({
      sha256: sha256Bytes(new Uint8Array(0)),
      sizeBytes: 0,
    });
  });

  it("reads in bounded chunks and never asks for the whole file at once", () => {
    const path = join(root(), "bounded-chunks");
    writeFileSync(path, new Uint8Array(200_000));
    const sizes: number[] = [];
    let closed = 0;
    hashRegularFile(path, "bundle-database-invalid", {
      closeSync: () => {
        closed += 1;
      },
      readSync: (_descriptor, buffer) => {
        sizes.push(buffer.byteLength);
        return sizes.length < 3 ? buffer.byteLength : 0;
      },
      fstatSync: (descriptor) => {
        const stats = fstatSync(descriptor);
        return Object.assign({}, stats, { isFile: () => true, size: 2 * 65_536 });
      },
    });
    expect(sizes).toEqual([65_536, 65_536, 65_536]);
    expect(closed).toBe(1);
  });

  it("refuses links, directories, missing files and files that change while read", () => {
    const path = join(root(), "regular");
    writeFileSync(path, "database");
    linkSync(path, join(root(), "hard-link"));
    symlinkSync(path, join(root(), "soft-link"));
    mkdirSync(join(root(), "directory"));
    for (const name of ["regular", "hard-link", "soft-link", "directory", "missing"]) {
      expectRecoveryError(
        () => hashRegularFile(join(root(), name), "bundle-database-invalid"),
        "bundle-database-invalid",
      );
    }
    const stable = join(root(), "stable");
    writeFileSync(stable, "abc");
    let call = 0;
    expectRecoveryError(
      () =>
        hashRegularFile(stable, "bundle-database-invalid", {
          fstatSync: (descriptor) => {
            const stats = fstatSync(descriptor);
            return Object.assign(
              {},
              stats,
              { isFile: () => true },
              call++ === 0 ? {} : { size: 9 },
            );
          },
        }),
      "bundle-database-invalid",
    );
  });

  it("verifies a database digest and size without returning its bytes", () => {
    const path = join(root(), "database.sqlite");
    writeFileSync(path, "database-bytes");
    const record = recoveryManifest().database;
    verifyDatabaseFile(path, record);
    for (const wrong of [
      { ...record, sha256: "0".repeat(64) },
      { ...record, sizeBytes: record.sizeBytes + 1 },
    ]) {
      expectRecoveryError(() => {
        verifyDatabaseFile(path, wrong);
      }, "bundle-database-invalid");
    }
  });

  it("verifies an artifact whose database is larger than the per-file limit", () => {
    const bytes = new Uint8Array(1000).fill(7);
    const base = join(root(), "large-database-artifact");
    const manifest = writeRecoveryArtifact(base);
    const large = {
      ...manifest,
      database: { ...manifest.database, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength },
    };
    writeFileSync(join(base, "database.sqlite"), bytes);
    const limits = { fileBytes: 64, fileCount: 4, totalBytes: 14 };
    expect(verifyArtifactFiles(base, large, limits)).toEqual([
      join(base, "database.sqlite"),
      join(base, "state/file"),
    ]);
    expect(verifyArtifactFilesWithDatabase(base, large, limits).database).toEqual({
      path: join(base, "database.sqlite"),
      record: large.database,
    });
  });
});
