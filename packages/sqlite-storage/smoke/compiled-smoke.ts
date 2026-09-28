import { initializeSqliteStorage, restoreSqliteBackup, SqliteStorageError } from "../src/index.js";

function requiredArgument(index: number): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) {
    throw new Error("A required smoke-test argument is missing.");
  }
  return value;
}

function initialize(databasePath: string): void {
  const storage = initializeSqliteStorage({ databasePath });
  const version = storage.schema.version;
  storage.close();
  process.stdout.write(`${JSON.stringify({ mode: "initialize", version })}\n`);
}

function backupAndRestore(databasePath: string, restoredPath: string): void {
  const source = initializeSqliteStorage({ databasePath });
  const backup = source.createBackup();
  source.close();
  const restored = restoreSqliteBackup({ backup, databasePath: restoredPath });
  const version = restored.schema.version;
  restored.close();
  process.stdout.write(`${JSON.stringify({ mode: "backup-restore", version })}\n`);
}

function run(): void {
  const mode = requiredArgument(2);
  const databasePath = requiredArgument(3);
  if (mode === "initialize") {
    initialize(databasePath);
    return;
  }
  if (mode === "backup-restore") {
    backupAndRestore(databasePath, requiredArgument(4));
    return;
  }
  throw new Error("The smoke-test mode is invalid.");
}

try {
  run();
} catch (error) {
  const code = error instanceof SqliteStorageError ? error.code : "smoke-failed";
  process.stderr.write(`${JSON.stringify({ code, ok: false })}\n`);
  process.exit(1);
}
