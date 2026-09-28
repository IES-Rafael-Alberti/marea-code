import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeSqliteStorage } from "@marea/sqlite-storage";

import { createRecoveryBundle, restoreRecoveryBundle } from "../index.js";

const root = mkdtempSync(join(tmpdir(), "marea-recovery-smoke-"));

try {
  const databasePath = join(root, "teacher.sqlite");
  const storage = initializeSqliteStorage({ databasePath });
  const schemaVersion = storage.schema.version;
  storage.database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
    ["class:smoke", "smoke", "Recovery smoke class"],
  );
  const stateRoot = join(root, "state");
  mkdirSync(join(root, "configuration.json"));
  mkdirSync(join(stateRoot, "snapshots"), { recursive: true });
  writeFileSync(join(stateRoot, "configuration.json"), "Teaching configuration bytes.");
  writeFileSync(join(stateRoot, "snapshots/run.json"), "Immutable run snapshot bytes.");

  const createBackup = storage.createBackup.bind(storage);
  const bundle = createRecoveryBundle(join(root, "bundle"), {
    createBackup: { createBackup },
    createExclusive: (operation) => operation(),
    files: ["configuration.json", "snapshots/run.json"],
    limits: { fileBytes: 262_144, fileCount: 2, totalBytes: 1_048_576 },
    release: { id: "release:smoke", schemaVersion },
    sourceRoot: stateRoot,
  });
  storage.close();

  const restored = restoreRecoveryBundle(
    { destinationRoot: join(root, "restored"), path: bundle.path },
    { id: "release:smoke", schemaVersion },
    { fileBytes: 262_144, fileCount: 2, totalBytes: 1_048_576 },
  );
  restored.database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
    ["class:restored", "restored", "Restored persistence class"],
  );
  const configuration = readFileSync(join(root, "restored/configuration.json"), "utf8");
  const snapshot = readFileSync(join(root, "restored/snapshots/run.json"), "utf8");
  restored.close();

  const reopened = initializeSqliteStorage({
    databasePath: join(root, "restored/database.sqlite"),
  });
  const row = reopened.database.readOne(
    "SELECT id, display_name FROM marea_classes WHERE id = ?1",
    ["class:smoke"],
  );
  const persistedRow = reopened.database.readOne(
    "SELECT id, display_name FROM marea_classes WHERE id = ?1",
    ["class:restored"],
  );
  const restoredSchemaVersion = reopened.schema.version;
  reopened.close();

  const actual = {
    configuration,
    persisted: persistedRow,
    restored: row,
    snapshot,
    schemaVersion,
    restoredSchemaVersion,
  };
  const expected = {
    configuration: "Teaching configuration bytes.",
    persisted: { id: "class:restored", display_name: "Restored persistence class" },
    restored: { id: "class:smoke", display_name: "Recovery smoke class" },
    snapshot: "Immutable run snapshot bytes.",
    schemaVersion,
    restoredSchemaVersion,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("The restored recovery bundle did not match the source state.");
  }

  process.stdout.write(
    `${JSON.stringify({
      database: { restored: row, persisted: persistedRow },
      files: [configuration, snapshot],
      manifest: bundle.manifest,
      ok: true,
      schemaVersion: restoredSchemaVersion,
    })}\n`,
  );
} finally {
  rmSync(root, { recursive: true });
}
