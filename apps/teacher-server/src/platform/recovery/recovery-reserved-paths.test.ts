import { describe, expect, it } from "vitest";

import { parseManifest } from "./manifest.boundary.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";

const release = { id: "release:one", schemaVersion: 1 };
const database = {
  format: "sqlite3",
  path: "database.sqlite",
  sha256: "0".repeat(64),
  sizeBytes: 1,
  schemaVersion: 1,
};
const state = { path: "state/file", sha256: "0".repeat(64), sizeBytes: 1 } as const;
const manifest = {
  database,
  files: [state],
  format: "marea-recovery",
  release,
  schemaVersion: 1,
};

function manifestWithFiles(files: readonly unknown[]): string {
  return JSON.stringify({ ...manifest, files });
}

describe("recovery reserved manifest paths", () => {
  it("rejects database records independently of their position", () => {
    const databaseRecord = { path: "database.sqlite", sha256: "0".repeat(64), sizeBytes: 1 };
    for (const files of [
      [databaseRecord],
      [databaseRecord, state],
      [state, databaseRecord, state],
      [state, databaseRecord],
    ]) {
      expectRecoveryError(
        () => parseManifest(new TextEncoder().encode(manifestWithFiles(files)), "release:one"),
        "bundle-manifest-invalid",
      );
    }
  });

  it("rejects reserved manifest records independently of their position", () => {
    const manifestRecord = { path: "manifest.json", sha256: "0".repeat(64), sizeBytes: 1 };
    for (const files of [[manifestRecord], [manifestRecord, state], [state, manifestRecord]]) {
      expectRecoveryError(
        () => parseManifest(new TextEncoder().encode(manifestWithFiles(files)), "release:one"),
        "bundle-manifest-invalid",
      );
    }
  });

  it("preserves valid manifest parsing", () => {
    expect(
      parseManifest(new TextEncoder().encode(JSON.stringify(manifest)), "release:one"),
    ).toEqual(manifest);
  });
});
