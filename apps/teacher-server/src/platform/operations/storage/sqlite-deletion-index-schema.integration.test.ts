import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => ({
  Database: vi.fn(() => {
    throw new Error("bun:sqlite is not used by the Node SQLite schema integration tests");
  }),
}));

import { Sha256DigestSchema } from "@marea/protocol";

import { NodeSqliteTestDatabase } from "../../../../test-support/node-sqlite-database.boundary.js";
import { targetIdentity, type TargetRef } from "../index.js";
import {
  createSqliteDeletionIndex,
  initializeDeletionIndex,
  parseStorageConfiguration,
  type StorageConfiguration,
} from "./index.js";

const digest = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
const target: TargetRef = {
  kind: "account",
  key: { userId: "user:schema" },
  observed: { kind: "version", version: "v1" },
};

function schemaConfiguration(root: string): StorageConfiguration {
  return parseStorageConfiguration({
    installationRoot: root,
    databasePath: join(root, "application.sqlite"),
    indexPath: join(root, "deletion-index.sqlite"),
    authorityLineage: "lineage:schema",
    rootId: "root:schema",
    databaseLineage: digest,
  });
}

function createIndependentSchema(database: NodeSqliteTestDatabase): void {
  // These are deliberately an independent catalog fixture, not a comparison
  // against DELETION_INDEX_SCHEMA. Drift must fail initialization validation.
  database.execute(
    `CREATE TABLE marea_deletion_index_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      authority_lineage TEXT NOT NULL,
      root_id TEXT NOT NULL,
      database_lineage TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'transfer-prepared', 'retired', 'uncertain', 'missing', 'corrupt')),
      pending_checkpoint_json TEXT CHECK (pending_checkpoint_json IS NULL OR json_valid(pending_checkpoint_json))
    ) STRICT`,
  );
  database.execute(
    `CREATE TABLE marea_deletion_index_tombstones (
      authority_lineage TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      target_json TEXT NOT NULL CHECK (json_valid(target_json)),
      operation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (authority_lineage, target_kind, logical_key)
    ) WITHOUT ROWID, STRICT`,
  );
  database.execute(
    `CREATE TABLE marea_deletion_index_checkpoints (
      operation_id TEXT PRIMARY KEY,
      checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json))
    ) STRICT`,
  );
}

function insertAuthority(database: NodeSqliteTestDatabase, config: StorageConfiguration): void {
  database.execute(
    "INSERT INTO marea_deletion_index_meta (singleton, authority_lineage, root_id, database_lineage, generation, state, pending_checkpoint_json) VALUES (1, ?1, ?2, ?3, 0, 'active', NULL)",
    [config.authorityLineage, config.rootId, config.databaseLineage],
  );
}

async function withInitializedSchema<T>(
  operation: (database: NodeSqliteTestDatabase, config: StorageConfiguration) => T | PromiseLike<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "marea-operations-schema-constraint-"));
  const config = schemaConfiguration(root);
  const database = new NodeSqliteTestDatabase();
  try {
    initializeDeletionIndex(database, config);
    return await operation(database, config);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("durable deletion-index SQLite schema", () => {
  it("creates the executable production schema with its catalog metadata", async () => {
    await withInitializedSchema((database) => {
      const createdSchema = database.readAll(
        "SELECT name, sql FROM sqlite_schema WHERE name LIKE 'marea_deletion_index_%' ORDER BY name",
      );
      const createdSql = new Map(createdSchema.map((row) => [String(row.name), String(row.sql)]));
      expect(createdSql.get("marea_deletion_index_meta")).toContain("CHECK (singleton = 1)");
      expect(createdSql.get("marea_deletion_index_tombstones")).toContain("WITHOUT ROWID");
      expect(createdSql.get("marea_deletion_index_checkpoints")).toContain(
        "CHECK (json_valid(checkpoint_json))",
      );
      expect(createdSchema).toHaveLength(3);
    });
  });

  it("enforces metadata restrictions against the initialized production schema", async () => {
    await withInitializedSchema((database) => {
      expect(() => {
        database.execute("UPDATE marea_deletion_index_meta SET singleton = 0 WHERE singleton = 1");
      }).toThrow("CHECK constraint failed: singleton = 1");
      expect(() => {
        database.execute(
          "UPDATE marea_deletion_index_meta SET generation = -1 WHERE singleton = 1",
        );
      }).toThrow("CHECK constraint failed: generation >= 0");
      expect(() => {
        database.execute(
          "UPDATE marea_deletion_index_meta SET state = 'invalid' WHERE singleton = 1",
        );
      }).toThrow(
        "CHECK constraint failed: state IN ('active', 'transfer-prepared', 'retired', 'uncertain', 'missing', 'corrupt')",
      );
      expect(() => {
        database.execute(
          "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = '{' WHERE singleton = 1",
        );
      }).toThrow(
        "CHECK constraint failed: pending_checkpoint_json IS NULL OR json_valid(pending_checkpoint_json)",
      );

      database.execute("UPDATE marea_deletion_index_meta SET generation = 3 WHERE singleton = 1");
      database.execute(
        "UPDATE marea_deletion_index_meta SET state = 'transfer-prepared' WHERE singleton = 1",
      );
      database.execute(
        'UPDATE marea_deletion_index_meta SET pending_checkpoint_json = \'{"operationId":"operation:metadata"}\' WHERE singleton = 1',
      );
      expect(
        database.readOne(
          "SELECT generation, state, pending_checkpoint_json FROM marea_deletion_index_meta WHERE singleton = 1",
        ),
      ).toMatchObject({
        generation: 3n,
        state: "transfer-prepared",
        pending_checkpoint_json: '{"operationId":"operation:metadata"}',
      });
    });
  });

  it("enforces tombstone JSON and primary-key restrictions against production schema", async () => {
    await withInitializedSchema((database, config) => {
      const targetJson = JSON.stringify(target);
      database.execute(
        "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [
          config.authorityLineage,
          target.kind,
          targetIdentity(target),
          targetJson,
          "operation:schema",
          "2026-09-14T10:00:00.000Z",
        ],
      );
      expect(
        database.readOne(
          "SELECT target_json FROM marea_deletion_index_tombstones WHERE logical_key = ?1",
          [targetIdentity(target)],
        ),
      ).toMatchObject({ target_json: targetJson });
      expect(() => {
        database.execute(
          "UPDATE marea_deletion_index_tombstones SET target_json = '{' WHERE logical_key = ?1",
          [targetIdentity(target)],
        );
      }).toThrow("CHECK constraint failed: json_valid(target_json)");
      expect(() => {
        database.execute(
          "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
          [
            config.authorityLineage,
            target.kind,
            targetIdentity(target),
            targetJson,
            "operation:duplicate",
            "2026-09-14T10:00:00.000Z",
          ],
        );
      }).toThrow(
        "UNIQUE constraint failed: marea_deletion_index_tombstones.authority_lineage, marea_deletion_index_tombstones.target_kind, marea_deletion_index_tombstones.logical_key",
      );

      const secondTarget = { ...target, key: { userId: "user:schema-second" } };
      database.execute(
        "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [
          config.authorityLineage,
          secondTarget.kind,
          targetIdentity(secondTarget),
          JSON.stringify(secondTarget),
          "operation:second",
          "2026-09-14T10:01:00.000Z",
        ],
      );
      expect(database.readAll("SELECT * FROM marea_deletion_index_tombstones")).toHaveLength(2);
    });
  });

  it("enforces checkpoint and target JSON restrictions independently", async () => {
    await withInitializedSchema((database) => {
      database.execute(
        "INSERT INTO marea_deletion_index_checkpoints (operation_id, checkpoint_json, targets_json) VALUES (?1, ?2, ?3)",
        ["operation:valid", '{"generation":0}', "[]"],
      );
      expect(
        database.readOne(
          "SELECT checkpoint_json, targets_json FROM marea_deletion_index_checkpoints WHERE operation_id = ?1",
          ["operation:valid"],
        ),
      ).toMatchObject({ checkpoint_json: '{"generation":0}', targets_json: "[]" });
      expect(() => {
        database.execute(
          "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = '{' WHERE operation_id = ?1",
          ["operation:valid"],
        );
      }).toThrow("CHECK constraint failed: json_valid(checkpoint_json)");
      expect(() => {
        database.execute(
          "UPDATE marea_deletion_index_checkpoints SET targets_json = '{' WHERE operation_id = ?1",
          ["operation:valid"],
        );
      }).toThrow("CHECK constraint failed: json_valid(targets_json)");

      database.execute(
        'UPDATE marea_deletion_index_checkpoints SET checkpoint_json = \'{"generation":1}\', targets_json = \'[{"kind":"account"}]\' WHERE operation_id = ?1',
        ["operation:valid"],
      );
      expect(
        database.readOne(
          "SELECT checkpoint_json, targets_json FROM marea_deletion_index_checkpoints WHERE operation_id = ?1",
          ["operation:valid"],
        ),
      ).toMatchObject({
        checkpoint_json: '{"generation":1}',
        targets_json: '[{"kind":"account"}]',
      });
    });
  });

  it("accepts an independent canonical catalog across initialization and reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "marea-operations-schema-reopen-"));
    const config = schemaConfiguration(root);
    const indexPath = config.indexPath;
    const database = new NodeSqliteTestDatabase(indexPath);
    let databaseClosed = false;
    try {
      createIndependentSchema(database);
      insertAuthority(database, config);
      expect(() => {
        initializeDeletionIndex(database, config);
      }).not.toThrow();
      const tableList = database
        .readAll("PRAGMA table_list")
        .filter(
          (row) => typeof row.name === "string" && row.name.startsWith("marea_deletion_index_"),
        );
      expect(tableList).toHaveLength(3);
      expect(tableList).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "marea_deletion_index_meta", wr: 0n, strict: 1n }),
          expect.objectContaining({ name: "marea_deletion_index_tombstones", wr: 1n, strict: 1n }),
          expect.objectContaining({ name: "marea_deletion_index_checkpoints", wr: 0n, strict: 1n }),
        ]),
      );
      expect(
        database.readAll("PRAGMA table_info(marea_deletion_index_meta)").map((row) => row.name),
      ).toEqual([
        "singleton",
        "authority_lineage",
        "root_id",
        "database_lineage",
        "generation",
        "state",
        "pending_checkpoint_json",
      ]);
      expect(
        database
          .readAll("PRAGMA table_info(marea_deletion_index_tombstones)")
          .map((row) => row.name),
      ).toEqual([
        "authority_lineage",
        "target_kind",
        "logical_key",
        "target_json",
        "operation_id",
        "created_at",
      ]);
      expect(
        database
          .readAll("PRAGMA table_info(marea_deletion_index_checkpoints)")
          .map((row) => row.name),
      ).toEqual(["operation_id", "checkpoint_json", "targets_json"]);
      database.close();
      databaseClosed = true;

      const reopened = new NodeSqliteTestDatabase(indexPath);
      try {
        expect(() => {
          initializeDeletionIndex(reopened, config);
        }).not.toThrow();
        await expect(createSqliteDeletionIndex(reopened, config).inspect()).resolves.toMatchObject({
          authorityLineage: config.authorityLineage,
          rootId: config.rootId,
          databaseLineage: config.databaseLineage,
          generation: 0,
          state: "active",
        });
      } finally {
        reopened.close();
      }
    } finally {
      if (!databaseClosed) database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects drift in an independently cataloged schema", () => {
    const database = new NodeSqliteTestDatabase();
    const root = mkdtempSync(join(tmpdir(), "marea-operations-schema-drift-"));
    const config = schemaConfiguration(root);
    try {
      createIndependentSchema(database);
      database.execute("ALTER TABLE marea_deletion_index_checkpoints ADD COLUMN drift_marker TEXT");
      insertAuthority(database, config);
      expect(() => {
        initializeDeletionIndex(database, config);
      }).toThrow("Deletion index schema is foreign.");
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
