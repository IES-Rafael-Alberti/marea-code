import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMigrationCatalog, initializeSqliteStorage } from "@marea/sqlite-storage";
import {
  createDefaultDependencies,
  initializeSqliteStorageWith,
} from "../../../../../../packages/sqlite-storage/src/storage.js";

import { createRecoveryBundle, restoreRecoveryBundle } from "../index.js";

const root = mkdtempSync(join(tmpdir(), "marea-recovery-legacy-smoke-"));

try {
  const legacyDatabasePath = join(root, "legacy.sqlite");
  const legacyStorage = initializeSqliteStorageWith(
    { databasePath: legacyDatabasePath },
    {
      ...createDefaultDependencies(),
      migrations: createMigrationCatalog().slice(0, 2),
    },
  );
  const schemaVersion = legacyStorage.schema.version;
  validateLegacySchema(schemaVersion);
  legacyStorage.database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
    ["class:legacy", "legacy", "Legacy migration class"],
  );
  const backup = legacyStorage.createBackup();
  validateBackupSchema(backup.schemaVersion);

  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, "legacy.json"), "Legacy state bytes.");

  const bundle = createRecoveryBundle(join(root, "bundle"), {
    createBackup: { createBackup: legacyStorage.createBackup.bind(legacyStorage) },
    createExclusive: (operation) => operation(),
    files: ["legacy.json"],
    limits: { fileBytes: 262_144, fileCount: 1, totalBytes: 1_048_576 },
    release: { id: "release:legacy-smoke", schemaVersion },
    sourceRoot: stateRoot,
  });
  legacyStorage.close();

  const corrupted = join(root, "corrupted");
  mkdirSync(corrupted, { recursive: true });
  writeFileSync(join(corrupted, "manifest.json"), readFileSync(join(bundle.path, "manifest.json")));
  const tamperedManifest = JSON.parse(readFileSync(join(corrupted, "manifest.json"), "utf8")) as {
    database: { sha256: string };
  };
  tamperedManifest.database.sha256 = "0".repeat(64);
  writeFileSync(join(corrupted, "manifest.json"), JSON.stringify(tamperedManifest));
  for (const name of ["database.sqlite", "legacy.json"]) {
    writeFileSync(join(corrupted, name), readFileSync(join(bundle.path, name)));
  }
  let rejectedCorruptRestore = false;
  try {
    restoreRecoveryBundle(
      { destinationRoot: join(root, "failed-restore"), path: corrupted },
      { id: "release:legacy-smoke", schemaVersion },
      { fileBytes: 262_144, fileCount: 1, totalBytes: 1_048_576 },
    ).close();
  } catch {
    rejectedCorruptRestore = true;
  }
  validatePreserved(
    rejectedCorruptRestore &&
      Buffer.from(readFileSync(join(bundle.path, "database.sqlite"))).equals(backup.bytes) &&
      !existsSync(join(root, "failed-restore")),
  );

  const restored = restoreRecoveryBundle(
    { destinationRoot: join(root, "restored"), path: bundle.path },
    { id: "release:legacy-smoke", schemaVersion },
    { fileBytes: 262_144, fileCount: 1, totalBytes: 1_048_576 },
  );
  validateRestoredSchema(restored.schema.version);
  restored.database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
    ["class:restored", "restored", "Restored legacy class"],
  );
  const state = readFileSync(join(root, "restored/legacy.json"), "utf8");
  restored.close();

  const reopened = initializeSqliteStorage({
    databasePath: join(root, "restored/database.sqlite"),
  });
  const legacyRow = reopened.database.readOne(
    "SELECT display_name FROM marea_classes WHERE id = ?1",
    ["class:legacy"],
  );
  const persistedRow = reopened.database.readOne(
    "SELECT display_name FROM marea_classes WHERE id = ?1",
    ["class:restored"],
  );
  const restoredSchemaVersion = reopened.schema.version;
  reopened.close();

  const actual = {
    legacyRow,
    persistedRow,
    preserved: true,
    schemaVersion,
    state,
    restoredSchemaVersion,
  };
  const expected = {
    legacyRow: { display_name: "Legacy migration class" },
    persistedRow: { display_name: "Restored legacy class" },
    preserved: true,
    schemaVersion: 2,
    state: "Legacy state bytes.",
    restoredSchemaVersion: 6,
  };
  validateLegacyEvidence(actual, expected);
  process.stdout.write(
    `${JSON.stringify({
      database: { legacy: legacyRow, persisted: persistedRow },
      files: [state],
      manifest: bundle.manifest,
      ok: true,
      schemaVersion: restoredSchemaVersion,
    })}\n`,
  );
} finally {
  rmSync(root, { recursive: true });
}

export function validateLegacySchema(schemaVersion: number): void {
  if (schemaVersion !== 2) {
    throw new Error(`Expected legacy schema 2, received ${String(schemaVersion)}.`);
  }
}

export function validateRestoredSchema(schemaVersion: number): void {
  if (schemaVersion !== 6) {
    throw new Error(`Expected migrated schema 6, received ${String(schemaVersion)}.`);
  }
}

export function validateBackupSchema(schemaVersion: number): void {
  if (schemaVersion !== 2) throw new Error("The legacy backup schema was unexpected.");
}

export function validatePreserved(preserved: boolean): void {
  if (!preserved) throw new Error("A failed restore did not preserve owned bytes and destination.");
}

export function equalJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function validateLegacyEvidence(actual: unknown, expected: unknown): void {
  if (!equalJson(actual, expected)) {
    throw new Error("The restored legacy recovery bundle did not match expected evidence.");
  }
}
