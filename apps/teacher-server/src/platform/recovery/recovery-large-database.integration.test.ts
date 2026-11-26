import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

const volume = vi.hoisted(() => ({ availableBytes: 1_000_000_000_000 }));
vi.mock("../../../../../packages/sqlite-storage/src/disk-space.boundary.js", () => ({
  diskSpace: { freeBytes: () => volume.availableBytes },
}));

import { initializeSqliteStorage } from "@marea/sqlite-storage";

import { RecoveryBundleError, createRecoveryBundle, restoreRecoveryBundle } from "./index.js";
import { readVerifiedBundle } from "../operations/retention/retention-backups.boundary.js";

const roots: string[] = [];
afterEach(() => {
  volume.availableBytes = 1_000_000_000_000;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The state-file limits an installation carries; the database is far larger than all of them. */
const LIMITS = { fileBytes: 4096, fileCount: 2, totalBytes: 8192 };
const RELEASE_ID = "release:large";

function installation() {
  const root = mkdtempSync(join(tmpdir(), "marea-recovery-large-"));
  roots.push(root);
  const storage = initializeSqliteStorage({ databasePath: join(root, "teacher.sqlite") });
  storage.database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
    ["class:large", "large", "Synthetic large class"],
  );
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state/configuration.json"), "Synthetic state.");
  return { root, storage };
}

function exclusive<T>(operation: () => T): T {
  return operation();
}

function bundleInput(root: string, storage: ReturnType<typeof installation>["storage"]) {
  return {
    createBackup: storage,
    createExclusive: exclusive,
    files: ["state/configuration.json"],
    limits: LIMITS,
    release: { id: RELEASE_ID, schemaVersion: storage.schema.version },
    sourceRoot: root,
  };
}

describe("backing up a database larger than the state-file limits", () => {
  it("backs up, verifies and restores a database that exceeds every configured limit", () => {
    const { root, storage } = installation();
    const bundle = createRecoveryBundle(join(root, "bundle"), bundleInput(root, storage));
    const databaseBytes = statSync(join(bundle.path, "database.sqlite")).size;
    expect(databaseBytes).toBeGreaterThan(LIMITS.totalBytes);
    expect(bundle.manifest.database.sizeBytes).toBe(databaseBytes);
    expect(statSync(join(bundle.path, "database.sqlite")).mode & 0o777).toBe(0o600);

    expect(readVerifiedBundle(bundle.path, LIMITS).bytes).toBeGreaterThan(LIMITS.totalBytes);

    const restored = restoreRecoveryBundle(
      { destinationRoot: join(root, "restored"), path: bundle.path },
      { id: RELEASE_ID, schemaVersion: storage.schema.version },
      LIMITS,
    );
    expect(
      restored.database.readOne("SELECT display_name FROM marea_classes WHERE id = ?1", [
        "class:large",
      ]),
    ).toEqual({ display_name: "Synthetic large class" });
    restored.close();
    storage.close();
  });

  it("refuses before copying when the volume lacks the space, naming both figures", () => {
    const { root, storage } = installation();
    volume.availableBytes = 1_048_576;
    let failure: unknown;
    try {
      createRecoveryBundle(join(root, "bundle"), bundleInput(root, storage));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RecoveryBundleError);
    expect(failure).toMatchObject({ code: "bundle-insufficient-space" });
    expect((failure as Error).message).toMatch(
      /^The SQLite backup needs \d+ MiB of free disk space but only 1 MiB is available\.$/u,
    );
    expect(existsSync(join(root, "bundle"))).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.includes(".marea-recovery."))).toEqual([]);
    storage.close();
  });
});
