import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SqliteBackup, SqliteStorage } from "@marea/sqlite-storage";

const legacyBackupBytes = new TextEncoder().encode("legacy-sqlite");
const state = {
  acceptCorruptRestore: false,
  backupSchemaVersion: 2,
  bundleDatabaseBytes: legacyBackupBytes,
  bundleInput: undefined as unknown,
  bundlePath: "",
  closed: 0,
  dependencies: undefined as unknown,
  directories: [] as [string, { recursive: true }][],
  failedRestoreLimit: undefined as unknown,
  failedRestoreOptions: undefined as unknown,
  failedRestoreRelease: undefined as unknown,
  failedRestoreExists: false,
  files: new Map<string, Uint8Array>(),
  initializeOptions: undefined as unknown,
  legacySchemaVersion: 2,
  legacyWrites: [] as [string, readonly unknown[]][],
  readStatements: [] as string[],
  reads: [] as string[],
  removed: [] as [string, { recursive: true }][],
  reopenOptions: undefined as unknown,
  restoredRows: new Map<string, unknown>(),
  restoredSchemaVersion: 6,
  restoredWrites: [] as [string, readonly unknown[]][],
  restoreCalls: [] as [unknown, unknown, unknown][],
  exclusiveCalls: 0,
  root: "/controlled/marea-recovery-legacy-smoke-root",
  stdout: "",
  temporaryPrefix: "",
  writes: [] as [string, Uint8Array][],
};

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return {
    ...actual,
    existsSync: (path: string) => state.failedRestoreExists && path.endsWith("failed-restore"),
    mkdirSync: (path: string, options: { recursive: true }) => {
      state.directories.push([path, options]);
      return undefined;
    },
    mkdtempSync: (prefix: string) => {
      state.temporaryPrefix = prefix;
      return state.root;
    },
    readFileSync: (path: string, encoding?: "utf8") => {
      const stored = state.files.get(path);
      if (stored === undefined) throw new Error(`unavailable: ${path}`);
      state.reads.push(path);
      return encoding === "utf8" ? new TextDecoder().decode(stored) : stored;
    },
    rmSync: (path: string, options: { recursive: true }) => {
      state.removed.push([path, options]);
    },
    writeFileSync: (path: string, data: string | Uint8Array) => {
      const owned = bytes(data);
      state.files.set(path, owned);
      state.writes.push([path, owned]);
    },
  };
});

const legacyBackup: SqliteBackup = {
  bytes: legacyBackupBytes,
  format: "sqlite3",
  schemaVersion: state.legacySchemaVersion,
  sha256: createHash("sha256").update(legacyBackupBytes).digest("hex"),
};

vi.mock("@marea/sqlite-storage", () => {
  const reopened = {
    close: () => {
      state.closed += 1;
    },
    database: {
      readOne: (statement: string, parameters: readonly unknown[]) => {
        state.readStatements.push(statement);
        return state.restoredRows.get(String(parameters[0]));
      },
    },
    schema: {
      get version(): number {
        return state.restoredSchemaVersion;
      },
    },
  };
  return {
    createMigrationCatalog: () => ["migration-one", "migration-two", "migration-three"],
    initializeSqliteStorage: (options: { databasePath: string }) => {
      state.reopenOptions = options;
      if (!options.databasePath.endsWith("restored/database.sqlite")) {
        throw new Error("unexpected reopen path");
      }
      return reopened as unknown as SqliteStorage;
    },
  };
});

vi.mock("../../../../../../packages/sqlite-storage/src/storage.js", () => {
  const legacy = {
    close: () => {
      state.closed += 1;
    },
    createBackup: () => ({
      ...legacyBackup,
      schemaVersion: state.backupSchemaVersion,
    }),
    database: {
      execute: (statement: string, parameters: readonly unknown[]) => {
        state.legacyWrites.push([statement, parameters]);
      },
    },
    schema: {
      get version(): number {
        return state.legacySchemaVersion;
      },
    },
  };
  return {
    createDefaultDependencies: () => ({ migrations: ["default"] }),
    initializeSqliteStorageWith: (options: { databasePath: string }, dependencies: unknown) => {
      state.dependencies = dependencies;
      state.initializeOptions = options;
      if (!options.databasePath.endsWith("legacy.sqlite")) throw new Error("unexpected path");
      return legacy as unknown as SqliteStorage;
    },
  };
});

vi.mock("../index.js", () => {
  const restored = {
    close: () => {
      state.closed += 1;
    },
    database: {
      execute: (statement: string, parameters: readonly unknown[]) => {
        state.restoredWrites.push([statement, parameters]);
      },
    },
    schema: {
      get version(): number {
        return state.restoredSchemaVersion;
      },
    },
  };
  return {
    createRecoveryBundle: (path: string, input: unknown) => {
      state.bundleInput = input;
      state.bundlePath = path;
      if (!path.endsWith("/bundle")) throw new Error("unexpected bundle path");
      const createInput = input as {
        createBackup: { createBackup: () => SqliteBackup };
        createExclusive: (operation: () => undefined) => undefined;
      };
      expect(createInput.createBackup.createBackup()).toEqual(legacyBackup);
      createInput.createExclusive(() => {
        state.exclusiveCalls += 1;
        return undefined;
      });
      return { input, manifest: { release: { id: "release:legacy-smoke" } }, path };
    },
    restoreRecoveryBundle: (options: unknown, release: unknown, limits: unknown) => {
      const restoreOptions = options as { destinationRoot: string };
      state.restoreCalls.push([options, release, limits]);
      if (restoreOptions.destinationRoot.endsWith("failed-restore")) {
        state.failedRestoreOptions = options;
        state.failedRestoreRelease = release;
        state.failedRestoreLimit = limits;
        if (!state.acceptCorruptRestore) throw new Error("destination occupied");
      }
      return { limits, options, release, ...restored } as unknown as SqliteStorage;
    },
  };
});

const limits = { fileBytes: 262_144, fileCount: 1, totalBytes: 1_048_576 };
const release = { id: "release:legacy-smoke", schemaVersion: 2 };

function prepareBundleFiles(databaseBytes = legacyBackupBytes): void {
  state.files.set(
    join(state.root, "bundle/manifest.json"),
    new TextEncoder().encode('{"database":{"sha256":"a"}}'),
  );
  state.bundleDatabaseBytes = databaseBytes;
  state.files.set(join(state.root, "bundle/database.sqlite"), databaseBytes);
  state.files.set(join(state.root, "bundle/legacy.json"), new TextEncoder().encode("state"));
  state.files.set(
    join(state.root, "restored/legacy.json"),
    new TextEncoder().encode("Legacy state bytes."),
  );
}

function prepareLegacyRows(): void {
  state.restoredRows.set("class:legacy", { display_name: "Legacy migration class" });
  state.restoredRows.set("class:restored", { display_name: "Restored legacy class" });
}

function resetSmokeState(): void {
  vi.resetModules();
  state.acceptCorruptRestore = false;
  state.backupSchemaVersion = 2;
  state.bundleInput = undefined;
  state.bundlePath = "";
  state.closed = 0;
  state.dependencies = undefined;
  state.directories.length = 0;
  state.failedRestoreExists = false;
  state.failedRestoreLimit = undefined;
  state.failedRestoreOptions = undefined;
  state.failedRestoreRelease = undefined;
  state.files.clear();
  state.initializeOptions = undefined;
  state.legacySchemaVersion = 2;
  state.legacyWrites.length = 0;
  state.readStatements.length = 0;
  state.reads.length = 0;
  state.reopenOptions = undefined;
  state.removed.length = 0;
  state.restoredRows.clear();
  state.restoredSchemaVersion = 6;
  state.restoredWrites.length = 0;
  state.restoreCalls.length = 0;
  state.exclusiveCalls = 0;
  state.root = "/controlled/marea-recovery-legacy-smoke-root";
  state.stdout = "";
  state.temporaryPrefix = "";
  state.writes.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((value: string | Uint8Array) => {
    state.stdout += typeof value === "string" ? value : new TextDecoder().decode(value);
    return true;
  });
}

describe("real recovery legacy smoke", () => {
  beforeEach(resetSmokeState);

  it("does not report preservation when corrupt restoration succeeds or source bytes change", async () => {
    prepareBundleFiles();
    prepareLegacyRows();
    state.acceptCorruptRestore = true;
    await expect(import("./recovery-legacy.js")).rejects.toThrow(
      "A failed restore did not preserve",
    );
    expect(state.closed).toBe(2);
    resetSmokeState();
    prepareBundleFiles(new Uint8Array(legacyBackupBytes.byteLength));
    prepareLegacyRows();
    await expect(import("./recovery-legacy.js")).rejects.toThrow(
      "A failed restore did not preserve",
    );
  });

  it("rejects a failed restore that does not preserve the destination", async () => {
    prepareBundleFiles();
    prepareLegacyRows();
    state.failedRestoreExists = true;
    vi.resetModules();
    await expect(import("./recovery-legacy.js")).rejects.toThrow(
      "A failed restore did not preserve",
    );
  });

  it("runs and validates the complete real legacy round trip", async () => {
    state.restoredRows.set("class:legacy", { display_name: "Legacy migration class" });
    state.restoredRows.set("class:restored", { display_name: "Restored legacy class" });
    prepareBundleFiles();
    await expect(import("./recovery-legacy.js")).resolves.toBeDefined();
    expect(state.exclusiveCalls).toBe(1);
    expect(state.temporaryPrefix).toBe(join(tmpdir(), "marea-recovery-legacy-smoke-"));
    expect(state.initializeOptions).toEqual({ databasePath: join(state.root, "legacy.sqlite") });
    expect(state.dependencies).toEqual({
      migrations: ["migration-one", "migration-two"],
    });
    expect(state.directories).toEqual([
      [join(state.root, "state"), { recursive: true }],
      [join(state.root, "corrupted"), { recursive: true }],
    ]);
    expect(state.writes).toEqual([
      [join(state.root, "state/legacy.json"), new TextEncoder().encode("Legacy state bytes.")],
      [
        join(state.root, "corrupted/manifest.json"),
        new TextEncoder().encode('{"database":{"sha256":"a"}}'),
      ],
      [
        join(state.root, "corrupted/manifest.json"),
        new TextEncoder().encode(`{"database":{"sha256":"${"0".repeat(64)}"}}`),
      ],
      [join(state.root, "corrupted/database.sqlite"), legacyBackupBytes],
      [join(state.root, "corrupted/legacy.json"), new TextEncoder().encode("state")],
    ]);
    expect(state.legacyWrites).toEqual([
      [
        "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
        ["class:legacy", "legacy", "Legacy migration class"],
      ],
    ]);
    expect(state.restoredWrites).toEqual([
      [
        "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
        ["class:restored", "restored", "Restored legacy class"],
      ],
    ]);
    expect(state.reads).toEqual([
      join(state.root, "bundle/manifest.json"),
      join(state.root, "corrupted/manifest.json"),
      join(state.root, "bundle/database.sqlite"),
      join(state.root, "bundle/legacy.json"),
      join(state.root, "bundle/database.sqlite"),
      join(state.root, "restored/legacy.json"),
    ]);
    expect(state.readStatements).toEqual([
      "SELECT display_name FROM marea_classes WHERE id = ?1",
      "SELECT display_name FROM marea_classes WHERE id = ?1",
    ]);
    expect(state.bundlePath).toBe(join(state.root, "bundle"));
    expect(Object.keys(state.bundleInput as object).toSorted()).toEqual([
      "createBackup",
      "createExclusive",
      "files",
      "limits",
      "release",
      "sourceRoot",
    ]);
    expect(state.bundleInput).toMatchObject({
      files: ["legacy.json"],
      limits,
      release,
      sourceRoot: join(state.root, "state"),
    });
    expect(state.failedRestoreOptions).toEqual({
      destinationRoot: join(state.root, "failed-restore"),
      path: join(state.root, "corrupted"),
    });
    expect(state.failedRestoreRelease).toEqual(release);
    expect(state.failedRestoreLimit).toEqual(limits);
    expect(state.reopenOptions).toEqual({
      databasePath: join(state.root, "restored/database.sqlite"),
    });
    expect(state.restoreCalls).toEqual([
      [
        {
          destinationRoot: join(state.root, "failed-restore"),
          path: join(state.root, "corrupted"),
        },
        release,
        limits,
      ],
      [
        { destinationRoot: join(state.root, "restored"), path: join(state.root, "bundle") },
        release,
        limits,
      ],
    ]);
    expect(state.closed).toBe(3);
    expect(state.removed).toEqual([[state.root, { recursive: true }]]);
    expect(JSON.parse(state.stdout)).toEqual({
      database: {
        legacy: { display_name: "Legacy migration class" },
        persisted: { display_name: "Restored legacy class" },
      },
      files: ["Legacy state bytes."],
      manifest: { release: { id: "release:legacy-smoke" } },
      ok: true,
      schemaVersion: 6,
    });
  });

  it("rejects unsupported legacy, backup, restored, preservation and evidence states", async () => {
    vi.resetModules();
    prepareBundleFiles();
    state.restoredRows.set("class:legacy", { display_name: "Legacy migration class" });
    state.restoredRows.set("class:restored", { display_name: "Restored legacy class" });
    state.legacySchemaVersion = 1;
    vi.resetModules();
    await expect(import("./recovery-legacy.js")).rejects.toThrow("Expected legacy schema 2");

    resetSmokeState();
    prepareBundleFiles();
    state.backupSchemaVersion = 1;
    vi.resetModules();
    await expect(import("./recovery-legacy.js")).rejects.toThrow(
      "The legacy backup schema was unexpected.",
    );

    resetSmokeState();
    prepareBundleFiles();
    state.restoredSchemaVersion = 5;
    vi.resetModules();
    await expect(import("./recovery-legacy.js")).rejects.toThrow("Expected migrated schema 6");

    resetSmokeState();
    prepareBundleFiles();
    prepareLegacyRows();
    state.failedRestoreExists = true;
    vi.resetModules();
    await expect(import("./recovery-legacy.js")).rejects.toThrow(
      "A failed restore did not preserve",
    );

    resetSmokeState();
    prepareBundleFiles(new Uint8Array(12));
    state.restoredRows.set("class:legacy", { display_name: "Legacy migration class" });
    state.restoredRows.set("class:restored", { display_name: "Restored legacy class" });
    vi.resetModules();
    await expect(import("./recovery-legacy.js")).rejects.toThrow(
      "A failed restore did not preserve",
    );

    resetSmokeState();
    prepareBundleFiles();
    state.restoredRows.set("class:legacy", { display_name: "wrong" });
    state.restoredRows.set("class:restored", { display_name: "Restored legacy class" });
    vi.resetModules();
    await expect(import("./recovery-legacy.js")).rejects.toThrow("did not match expected evidence");
  });

  it("rejects unsupported backup and preservation values directly", async () => {
    prepareBundleFiles();
    state.restoredRows.set("class:legacy", { display_name: "Legacy migration class" });
    state.restoredRows.set("class:restored", { display_name: "Restored legacy class" });
    vi.resetModules();
    const smoke = await import("./recovery-legacy.js");
    expect(() => {
      smoke.validateBackupSchema(1);
    }).toThrow("The legacy backup schema was unexpected.");
    expect(() => {
      smoke.validateBackupSchema(2);
    }).not.toThrow();
    expect(() => {
      smoke.validatePreserved(false);
    }).toThrow("A failed restore did not preserve");
    expect(() => {
      smoke.validatePreserved(true);
    }).not.toThrow();
    expect(() => {
      smoke.validateLegacySchema(1);
    }).toThrow("Expected legacy schema 2");
    expect(() => {
      smoke.validateLegacySchema(2);
    }).not.toThrow();
    expect(() => {
      smoke.validateRestoredSchema(5);
    }).toThrow("Expected migrated schema 6");
    expect(() => {
      smoke.validateRestoredSchema(6);
    }).not.toThrow();
  });
});
