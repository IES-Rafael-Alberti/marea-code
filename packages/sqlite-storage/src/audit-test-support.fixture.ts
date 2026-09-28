import type { SqliteApplicationDatabase, SqliteParameter, SqliteRow } from "./contracts.js";
import type { SqliteDatabasePort } from "./database-port.js";
import { createMigrationCatalog, migrationLedgerSql } from "./migration-catalog.js";
import type { AuditOperationInput } from "./audit-storage.js";

type SqliteValue = Exclude<SqliteParameter, boolean>;
type MemoryDatabase = Pick<SqliteDatabasePort, "close" | "execute" | "readAll" | "readOne">;

function values(parameters: readonly SqliteParameter[]): SqliteValue[] {
  return parameters.map((parameter) =>
    typeof parameter === "boolean" ? Number(parameter) : parameter,
  );
}

// The audit assertions run on the real SQLite engine of each supported runtime.
const openMemoryDatabase: () => MemoryDatabase = process.versions.bun
  ? await import("./sqlite-driver.boundary.js").then(
      ({ bunSqliteDriver }) =>
        () =>
          bunSqliteDriver.open(":memory:"),
    )
  : await import("node:sqlite").then(({ DatabaseSync }) => () => {
      const database = new DatabaseSync(":memory:", { readBigInts: true });
      return {
        close: () => {
          database.close();
        },
        execute: (sql: string, parameters: readonly SqliteParameter[] = []) => {
          database.prepare(sql).run(...values(parameters));
        },
        readAll: (sql: string, parameters: readonly SqliteParameter[] = []) =>
          database.prepare(sql).all(...values(parameters)),
        readOne: (sql: string, parameters: readonly SqliteParameter[] = []) =>
          database.prepare(sql).get(...values(parameters)),
      };
    });

export class AuditTestDatabase implements SqliteApplicationDatabase {
  readonly #database = openMemoryDatabase();

  execute(sql: string, parameters: readonly SqliteParameter[] = []): void {
    this.#database.execute(sql, parameters);
  }

  readAll(sql: string, parameters: readonly SqliteParameter[] = []): readonly SqliteRow[] {
    return this.#database.readAll(sql, parameters);
  }

  readOne(sql: string, parameters: readonly SqliteParameter[] = []): SqliteRow | undefined {
    return this.#database.readOne(sql, parameters);
  }

  transaction<T>(operation: () => T): T {
    this.#database.execute("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = operation();
    } catch (error) {
      this.#database.execute("ROLLBACK");
      throw error;
    }
    this.#database.execute("COMMIT");
    return result;
  }

  close(): void {
    this.#database.close();
  }
}

export function baseAuditDatabase(): AuditTestDatabase {
  const database = new AuditTestDatabase();
  database.execute(migrationLedgerSql());
  for (const migration of createMigrationCatalog()) {
    for (const statement of migration.statements) database.execute(statement);
    database.execute(
      "INSERT INTO marea_schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
      [migration.version, migration.name, migration.checksum],
    );
  }
  database.execute("PRAGMA user_version = 8");
  return database;
}

export function auditArtifactJson(
  operationId: string,
  artifactDigest: string,
  observed: Record<string, string> = { kind: "version", version: "v1" },
): string {
  return JSON.stringify({
    format: "marea-retention-preview:1",
    previewId: operationId,
    requestId: "request:one",
    authorityLineage: "lineage:one",
    installationId: "root:one",
    sourceDatabaseLineage: `sha256:${"c".repeat(64)}`,
    actorBinding: "exclusive-installation-owner",
    policyRevision: "policy:one",
    expectedIndexGeneration: 0,
    targets: [{ kind: "account", key: { userId: "user:one" }, observed }],
    graphDigest: `sha256:${"b".repeat(64)}`,
    createdAt: "2026-09-13T10:00:00.000Z",
    expiresAt: "2026-09-13T10:10:00.000Z",
    artifactDigest,
  });
}

export function auditOperation(
  operationId: string,
  observed: Record<string, string> = { kind: "version", version: "v1" },
): AuditOperationInput {
  const artifactDigest = `sha256:${"a".repeat(64)}`;
  return {
    operationId,
    requestId: "request:one",
    authorityLineage: "lineage:one",
    actorBinding: "exclusive-installation-owner",
    policyRevision: "policy:one",
    artifactDigest,
    graphDigest: `sha256:${"b".repeat(64)}`,
    expectedIndexGeneration: 0,
    artifactJson: auditArtifactJson(operationId, artifactDigest, observed),
    state: "prepared",
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    errorCode: "none",
  };
}

export function plannedAuditDisposition(
  operationId: string,
  updatedAt: string,
  detailCode?: string | null,
) {
  return {
    operationId,
    targetKind: "account",
    logicalKey: '{"key":{"userId":"user:one"},"kind":"account"}',
    observedJson: "{}",
    disposition: "planned" as const,
    updatedAt,
    ...(detailCode !== undefined ? { detailCode } : {}),
  };
}
