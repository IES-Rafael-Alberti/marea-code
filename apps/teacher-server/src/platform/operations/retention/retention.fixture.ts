import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sha256DigestSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { NodeSqliteTestDatabase } from "../../../../test-support/node-sqlite-database.boundary.js";
import { schemaEightDatabase } from "../../../../test-support/schema-eight-fixture.js";
import {
  recoveryManifest,
  recoveryTestLimits,
  writeRecoveryArtifact,
} from "../../recovery/recovery-test-artifact.fixture.js";
import type { MaintenanceCoordinator } from "../contracts.js";
import { RetentionPreviewRequestSchema, TargetRefSchema, type TargetRef } from "../schemas.js";
import {
  activateApplicationAuditSchema,
  createApplicationAuditStores,
} from "../storage/application-audit-store.js";
import { parseStorageConfiguration } from "../storage/configuration.js";
import { createSqliteAuditIndexEvidence } from "../storage/sqlite-audit-index-evidence.js";
import {
  createSqliteDeletionIndex,
  initializeDeletionIndex,
} from "../storage/sqlite-deletion-index.js";
import { createBackupInventory } from "./retention-backups.boundary.js";
import { readRetentionGraph } from "./retention-graph.js";
import { createRetentionService, type RetentionDependencies } from "./retention-service.js";

export const NOW = "2026-09-14T10:00:00.000Z";
export const EXPIRES = "2026-09-14T10:10:00.000Z";
export const LATER = "2026-09-14T11:00:00.000Z";
export const EARLIER = "2026-09-14T09:00:00.000Z";

function applicationDatabase(): NodeSqliteTestDatabase {
  const database = schemaEightDatabase();
  activateApplicationAuditSchema(database);
  return database;
}

function insert(
  database: SqliteApplicationDatabase,
  sql: string,
  rows: readonly (readonly (string | number | null)[])[],
) {
  for (const row of rows) database.execute(sql, [...row]);
}

/** Two students, one teacher, shared and exclusive snapshots, and every derived run table. */
export function seedRetention(database: SqliteApplicationDatabase): void {
  insert(database, "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?1, ?1)", [
    ["class:one"],
  ]);
  insert(
    database,
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES (?1, ?1, 'hash', ?2, ?1, ?3)",
    [
      ["student:one", "student", "class:one"],
      ["student:two", "student", "class:one"],
      ["teacher:one", "teacher", null],
    ],
  );
  insert(
    database,
    "INSERT INTO marea_run_snapshots (id, public_snapshot_json, provider_route_json, created_at) VALUES (?1, ?2, '{}', ?3)",
    [
      ["snapshot:own", '{"project":"own"}', EARLIER],
      ["snapshot:shared", '{"project":"shared"}', EARLIER],
    ],
  );
  insert(
    database,
    "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES (?1, ?2)",
    [["snapshot:own", '{"teaching":true}']],
  );
  insert(
    database,
    "INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at, closed_at) VALUES (?1, ?2, 'class:one', ?3, 'client', 'Project', ?4, ?5, ?6)",
    [
      ["run:closed", "student:one", "snapshot:own", "closed", EARLIER, EARLIER],
      ["run:shared", "student:one", "snapshot:shared", "closed", EARLIER, EARLIER],
      ["run:other", "student:two", "snapshot:shared", "closed", EARLIER, EARLIER],
    ],
  );
  insert(
    database,
    "INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json) VALUES (?1, ?2, ?3, ?4, 'message', ?5)",
    [
      ["event:1", "run:closed", 1, EARLIER, '{"content":"one"}'],
      ["event:2", "run:closed", 2, EARLIER, '{"content":"two"}'],
      ["event:3", "run:other", 1, EARLIER, '{"content":"other"}'],
    ],
  );
  insert(
    database,
    "INSERT INTO marea_run_leases (id, run_id, student_id, token_hash, issued_at, expires_at, revoked_at) VALUES (?1, 'run:closed', 'student:one', ?1, ?2, ?3, ?4)",
    [["lease:revoked", EARLIER, LATER, EARLIER]],
  );
  insert(
    database,
    "INSERT INTO marea_run_open_requests (student_id, idempotency_key, fingerprint, run_id) VALUES ('student:one', ?1, 'fp', 'run:closed')",
    [["open:1"]],
  );
  insert(
    database,
    "INSERT INTO marea_teacher_notices (id, run_id, student_id, class_id, teacher_id, teacher_display_name, source, text, created_at, idempotency_key, fingerprint) VALUES ('notice:1', 'run:closed', 'student:one', 'class:one', 'teacher:one', 'Teacher', 'approved-evaluation', ?1, ?2, 'notice', 'fp')",
    [["Well done", EARLIER]],
  );
  insert(
    database,
    "INSERT INTO marea_evaluations (id, run_id, generation, action_owner, action_key, request_fingerprint, input_json, input_digest, state, created_at, updated_at, draft_json, notice_id) VALUES ('evaluation:1', 'run:closed', 1, 'teacher:one', 'key', 'fp', '{}', 'digest', 'approved', ?1, ?1, '{\"draft\":1}', 'notice:1')",
    [[EARLIER]],
  );
  insert(
    database,
    "INSERT INTO marea_usage_accounts (run_id, purpose, policy_json, created_at) VALUES ('run:closed', ?1, '{}', ?2)",
    [["tutoring", EARLIER]],
  );
  insert(
    database,
    "INSERT INTO marea_usage_attempts (id, run_id, purpose, request_id, attempt, state, input_tokens, output_tokens, cost_units, created_at) VALUES (?1, 'run:closed', 'tutoring', 'request', 1, 'settled', 1, 1, 1, ?2)",
    [["attempt:1", EARLIER]],
  );
  insert(
    database,
    "INSERT INTO marea_usage_tool_calls (reservation_id, call_id) VALUES ('attempt:1', ?1)",
    [["call:1"]],
  );
}

/** Governance rows for `student:one`: account, center and class memberships, a revoked session and a used invitation. */
export function seedGovernance(database: SqliteApplicationDatabase): void {
  database.execute(
    "INSERT INTO marea_centers (id, display_name, version, created_at, updated_at) VALUES ('center:one', 'Center', 'center:v1', ?1, ?1)",
    [EARLIER],
  );
  database.execute(
    "INSERT INTO marea_governance_classes (class_id, center_id, version, created_at, updated_at) VALUES ('class:one', 'center:one', 'class:v1', ?1, ?1)",
    [EARLIER],
  );
  database.execute(
    "INSERT INTO marea_governance_accounts (user_id, owner_center_id, state, version, created_at, updated_at) VALUES ('student:one', 'center:one', 'active', 'account:v1', ?1, ?1)",
    [EARLIER],
  );
  database.execute(
    "INSERT INTO marea_center_memberships (center_id, user_id, capability, state, version, created_at, updated_at) VALUES ('center:one', 'student:one', 'member', 'active', 'center-member:v1', ?1, ?1)",
    [EARLIER],
  );
  database.execute(
    "INSERT INTO marea_governance_memberships (class_id, center_id, user_id, role, state, version, created_at, updated_at) VALUES ('class:one', 'center:one', 'student:one', 'student', 'active', 'class-member:v1', ?1, ?1)",
    [EARLIER],
  );
  database.execute(
    "INSERT INTO marea_auth_sessions (id, user_id, token_hash, issued_at, expires_at, revoked_at) VALUES ('session:old', 'student:one', 'hash', ?1, ?2, ?1)",
    [EARLIER, LATER],
  );
  database.execute(
    "INSERT INTO marea_invitations (code_hash, class_id, consumed_at, consumed_by) VALUES ('invitation:1', 'class:one', ?1, 'student:one')",
    [EARLIER],
  );
}

export function rowCount(
  database: SqliteApplicationDatabase,
  table: string,
  where = "1 = 1",
): number {
  return Number(database.readOne(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`)?.total);
}

function placeholder(kind: "run" | "account", id: string): object {
  return kind === "run"
    ? {
        kind: "run-snapshot",
        runId: id,
        snapshotId: "snapshot:none",
        snapshotDigest: `sha256:${"0".repeat(64)}`,
      }
    : { kind: "version", version: "version:none" };
}

export function target(value: object): TargetRef {
  return TargetRefSchema.parse(value);
}

export function retentionHarness(overrides: Partial<RetentionDependencies> = {}) {
  const root = mkdtempSync(join(tmpdir(), "marea-retention-"));
  const backupRoot = join(root, "backups");
  mkdirSync(backupRoot);
  const configuration = parseStorageConfiguration({
    installationRoot: root,
    databasePath: join(root, "application.sqlite"),
    indexPath: join(root, "deletion-index.sqlite"),
    authorityLineage: "lineage:retention",
    rootId: "root:retention",
    databaseLineage: Sha256DigestSchema.parse(`sha256:${"d".repeat(64)}`),
  });
  const database = applicationDatabase();
  seedRetention(database);
  seedGovernance(database);
  const indexDatabase = new NodeSqliteTestDatabase();
  initializeDeletionIndex(indexDatabase, configuration);
  const index = createSqliteDeletionIndex(indexDatabase, configuration);
  const backups = createBackupInventory({ backupRoot, limits: recoveryTestLimits });
  const coordinator: MaintenanceCoordinator = {
    preview: (operation) =>
      operation({
        database: {
          readAll: database.readAll.bind(database),
          readOne: database.readOne.bind(database),
        },
        graph: { read: () => Promise.reject(new Error("unused")) },
      }),
    run: (_input, operation) =>
      operation({ database, graph: { read: () => Promise.reject(new Error("unused")) } }),
  };
  const dependencies: RetentionDependencies = {
    coordinator,
    index,
    backups,
    installation: {
      authorityLineage: configuration.authorityLineage,
      rootId: configuration.rootId,
      databaseLineage: configuration.databaseLineage,
    },
    auditFor: (application) =>
      createApplicationAuditStores(
        application,
        createSqliteAuditIndexEvidence(indexDatabase, configuration),
      ),
    ...overrides,
  };
  const request = (targets: readonly object[], previewId = "preview:one") =>
    RetentionPreviewRequestSchema.parse({
      requestId: `request:${previewId}`,
      previewId,
      policyRevision: "policy:explicit",
      authorityLineage: configuration.authorityLineage,
      installationId: configuration.rootId,
      sourceDatabaseLineage: configuration.databaseLineage,
      expectedIndexGeneration: 0,
      targets: targets.map(target),
      createdAt: NOW,
      expiresAt: EXPIRES,
    });
  return {
    root,
    backupRoot,
    configuration,
    database,
    indexDatabase,
    index,
    backups,
    dependencies,
    service: createRetentionService(dependencies),
    request,
    writeBackup: (name: string) =>
      writeRecoveryArtifact(join(backupRoot, name), {
        ...recoveryManifest(),
        release: { id: `release:${name}`, schemaVersion: 1 },
      }),
    /** The current node for a root, so a request can name exactly what an operator reviewed. */
    observe: (kind: "run" | "account", id: string): TargetRef => {
      const key = kind === "run" ? { runId: id } : { userId: id };
      const graph = readRetentionGraph(
        database,
        backups.list(),
        [target({ kind, key, observed: placeholder(kind, id) })],
        NOW,
      );
      const node = graph.graph.nodes.find((candidate) => candidate.kind === kind);
      if (node === undefined) throw new Error("Missing observed root.");
      return node;
    },
  };
}
