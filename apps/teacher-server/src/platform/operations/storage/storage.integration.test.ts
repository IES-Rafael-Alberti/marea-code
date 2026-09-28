/* This integration boundary intentionally keeps one end-to-end SQLite fixture suite together. */
/* eslint-disable max-lines */

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => ({
  Database: vi.fn(() => {
    throw new Error("bun:sqlite is not used by the Node SQLite storage integration tests");
  }),
}));

import { Sha256DigestSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { NodeSqliteTestDatabase } from "../../../../test-support/node-sqlite-database.boundary.js";
import { schemaEightDatabase } from "../../../../test-support/schema-eight-fixture.js";
import {
  artifactDigest,
  authorityCheckpointDigest,
  AuthorityLineageSchema,
  IndexCheckpointSchema,
  type IndexCheckpoint,
  ManifestSha256Schema,
  PreviewArtifactSchema,
  RestoredDatabaseIdentitySchema,
  RootIdSchema,
  targetIdentity,
  type PreviewArtifact,
  type TargetRef,
} from "../index.js";
import {
  activateApplicationAuditSchema,
  createApplicationAuditStores,
  createSqliteAuditIndexEvidence,
  initializeDeletionIndex,
  createSqliteCreationGate,
  createSqliteDeletionIndex,
  parseStorageConfiguration,
  canonicalizeStorageConfiguration,
  normalizeSql,
  StorageConfigurationSchema,
  DELETION_INDEX_SCHEMA,
  DeletionIndexStorageError,
  type AuditAdvanceIntent,
  type AuditIndexEvidenceRequest,
  type AuditIndexEvidenceResult,
  type ContentDisposition,
  type SqliteAuditIndexEvidence,
  type SqliteAuditIndexEvidenceRequest,
  type SqliteAuditIndexEvidenceResult,
  type StorageConfiguration,
} from "./index.js";
import {
  inspectFromRow,
  readCheckpoint,
  readConsistentInspection,
} from "./sqlite-deletion-index-inspection.js";

function expectStorageError(
  operation: () => unknown,
  code: DeletionIndexStorageError["code"],
  message: string,
): void {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DeletionIndexStorageError);
  expect(error).toMatchObject({ code, message, name: "DeletionIndexStorageError" });
}

const digest = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
const configurationRoot = mkdtempSync(join(tmpdir(), "marea-operations-config-"));
const configuration = parseStorageConfiguration({
  installationRoot: configurationRoot,
  databasePath: join(configurationRoot, "application.sqlite"),
  indexPath: join(configurationRoot, "deletion-index.sqlite"),
  authorityLineage: "lineage:one",
  rootId: "root:one",
  databaseLineage: digest,
});
expect(() =>
  parseStorageConfiguration({
    ...configuration,
    indexPath: configuration.databasePath,
  }),
).toThrow("paths must differ");
expect(StorageConfigurationSchema.parse(configuration)).toEqual(configuration);
expect(Object.keys(StorageConfigurationSchema.shape)).toEqual([
  "installationRoot",
  "databasePath",
  "indexPath",
  "authorityLineage",
  "rootId",
  "databaseLineage",
]);
expect(DELETION_INDEX_SCHEMA).toHaveLength(3);

const target: TargetRef = {
  kind: "account",
  key: { userId: "user:one" },
  observed: { kind: "version", version: "v1" },
};

const preparedCheckpoint = (operationId: string): IndexCheckpoint =>
  IndexCheckpointSchema.parse({
    operationId,
    authorityLineage: configuration.authorityLineage,
    expectedIndexGeneration: 0,
    nextIndexGeneration: 1,
    targetCount: 1,
    artifactDigest: digest,
    state: "prepared",
  });

function artifact(): PreviewArtifact {
  const withoutDigest = PreviewArtifactSchema.omit({ artifactDigest: true }).parse({
    format: "marea-retention-preview:1",
    previewId: "preview:one",
    requestId: "request:one",
    authorityLineage: "lineage:one",
    installationId: "root:one",
    sourceDatabaseLineage: digest,
    actorBinding: "exclusive-installation-owner",
    policyRevision: "policy:one",
    expectedIndexGeneration: 0,
    targets: [target],
    graphDigest: digest,
    counts: { rows: 1, files: 0, backups: 0 },
    bytes: { database: 1, files: 0, backups: 0 },
    blockers: [],
    createdAt: "2026-09-13T10:00:00.000Z",
    expiresAt: "2026-09-13T10:10:00.000Z",
  });
  return PreviewArtifactSchema.parse({
    ...withoutDigest,
    artifactDigest: artifactDigest(withoutDigest),
  });
}

function restoredIdentity(
  config: StorageConfiguration,
  bundleDigest: ReturnType<typeof ManifestSha256Schema.parse>,
) {
  return RestoredDatabaseIdentitySchema.parse({
    rootId: config.rootId,
    sourceAuthorityLineage: config.authorityLineage,
    sourceDatabaseLineage: config.databaseLineage,
    sourceBundleManifestDigest: bundleDigest,
    sourceIndexGeneration: 0,
    sourceCheckpointDigest: authorityCheckpointDigest({
      authorityLineage: config.authorityLineage,
      rootId: config.rootId,
      indexGeneration: 0,
      databaseLineage: config.databaseLineage,
      bundleManifestDigest: bundleDigest,
    }),
    destinationAuthorityLineage: config.authorityLineage,
    destinationRootId: config.rootId,
  });
}

function fakeInspectionDatabase(
  checkpoints: readonly IndexCheckpoint[],
  selected: IndexCheckpoint,
  generation: number,
  pendingCheckpoint: IndexCheckpoint | null,
): SqliteApplicationDatabase {
  const checkpointRows = checkpoints.map((checkpoint) => ({
    operation_id: checkpoint.operationId,
    checkpoint_json: JSON.stringify(checkpoint),
    targets_json: JSON.stringify([target]),
  }));
  const tombstoneRows = checkpoints
    .filter((checkpoint) => checkpoint.durableIntent === "committed")
    .map((checkpoint) => ({
      authority_lineage: configuration.authorityLineage,
      target_kind: target.kind,
      logical_key: targetIdentity(target),
      target_json: JSON.stringify(target),
      operation_id: checkpoint.operationId,
    }));
  return {
    execute: () => undefined,
    readAll: (sql) =>
      sql.includes("marea_deletion_index_checkpoints")
        ? checkpointRows
        : sql.includes("marea_deletion_index_tombstones")
          ? tombstoneRows
          : [],
    readOne: (sql) =>
      sql.includes("marea_deletion_index_checkpoints")
        ? checkpointRows.find((row) => row.operation_id === selected.operationId)
        : {
            authority_lineage: configuration.authorityLineage,
            root_id: configuration.rootId,
            database_lineage: configuration.databaseLineage,
            generation,
            state: "active",
            pending_checkpoint_json: pendingCheckpoint ? JSON.stringify(pendingCheckpoint) : null,
          },
    transaction: (operation) => operation(),
  };
}

function mismatchedEvidence(
  evidence: Exclude<AuditIndexEvidenceResult, { kind: "unavailable" }>,
  key: keyof AuditIndexEvidenceRequest,
): Exclude<AuditIndexEvidenceResult, { kind: "unavailable" }> {
  switch (key) {
    case "operationId":
      return { ...evidence, operationId: "preview:other" };
    case "authorityLineage":
      return { ...evidence, authorityLineage: "lineage:other" };
    case "artifactDigest":
      return { ...evidence, artifactDigest: "sha256:" + "f".repeat(64) };
    case "expectedIndexGeneration":
      return { ...evidence, expectedIndexGeneration: 1 };
  }
}

describe("durable OPERATIONS storage adapters", () => {
  it("activates schema 9 explicitly and round-trips full audit artifacts and dispositions", () => {
    const database = schemaEightDatabase();
    activateApplicationAuditSchema(database);
    expect(database.readOne("PRAGMA user_version")).toEqual({ user_version: 9n });
    let contentState: "pending" | "in-progress" | "complete" = "pending";
    const stores = createApplicationAuditStores(database, {
      read(input: AuditIndexEvidenceRequest): AuditIndexEvidenceResult {
        return {
          kind: "intent" as const,
          operationId: input.operationId,
          authorityLineage: input.authorityLineage,
          artifactDigest: input.artifactDigest,
          expectedIndexGeneration: input.expectedIndexGeneration,
          nextIndexGeneration: input.expectedIndexGeneration + 1,
          state: "committed" as const,
          contentState,
          durableIntent: "committed" as const,
        };
      },
    });
    const value = artifact();
    stores.audit.recordPrepared(value, "2026-09-13T10:01:00.000Z");
    expect(stores.audit.read(value.previewId)?.artifactDigest).toBe(value.artifactDigest);
    const disposition: ContentDisposition = {
      target,
      disposition: "deleted",
      updatedAt: "2026-09-13T10:02:00.000Z",
    };
    stores.dispositions.record(value.previewId, disposition);
    expect(stores.dispositions.list(value.previewId)[0]).toMatchObject({ disposition: "deleted" });
    const firstAdvance: AuditAdvanceIntent = {
      operationId: value.previewId,
      expectedState: "prepared",
      nextState: "index-committed",
      now: "2026-09-13T10:02:30.000Z",
    };
    stores.audit.advance(firstAdvance);
    contentState = "in-progress";
    stores.audit.advance({
      operationId: value.previewId,
      expectedState: "index-committed",
      nextState: "content-started",
      now: "2026-09-13T10:02:40.000Z",
    });
    contentState = "complete";
    stores.audit.advance({
      operationId: value.previewId,
      expectedState: "content-started",
      nextState: "content-complete",
      now: "2026-09-13T10:02:50.000Z",
    });
    stores.audit.advance({
      operationId: value.previewId,
      expectedState: "content-complete",
      nextState: "applied",
      now: "2026-09-13T10:03:00.000Z",
    });
    expect(stores.audit.read(value.previewId)?.state).toBe("applied");
    database.close();
  });

  it("rejects pre-intent failure after an independently committed index", async () => {
    const auditDatabase = schemaEightDatabase();
    activateApplicationAuditSchema(auditDatabase);
    const indexDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(indexDatabase, configuration);
    const index = createSqliteDeletionIndex(indexDatabase, configuration);
    const stores = createApplicationAuditStores(
      auditDatabase,
      createSqliteAuditIndexEvidence(indexDatabase, configuration),
    );
    const value = artifact();
    stores.audit.recordPrepared(value, value.createdAt);
    const prepared = await index.prepare({
      operationId: value.previewId,
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: value.expectedIndexGeneration,
      targets: value.targets,
      artifactDigest: value.artifactDigest,
    });
    await index.commit(prepared);
    expect(() => {
      stores.audit.advance({
        operationId: value.previewId,
        expectedState: "prepared",
        nextState: "failed",
        now: "2026-09-13T10:01:00.000Z",
        errorCode: "interrupted",
      });
    }).toThrow("no-intent");
    expect(stores.audit.read(value.previewId)?.state).toBe("prepared");
    auditDatabase.close();
    indexDatabase.close();
  });

  it("keeps independent index intent and tombstones across reopen and blocks pending creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "marea-operations-index-"));
    const indexPath = join(root, "deletion-index.sqlite");
    const config: StorageConfiguration = {
      ...configuration,
      installationRoot: root,
      databasePath: join(root, "application.sqlite"),
      indexPath,
    };
    const first = new NodeSqliteTestDatabase(indexPath);
    initializeDeletionIndex(first, config);
    const index = createSqliteDeletionIndex(first, config);
    const checkpoint = await index.prepare({
      operationId: "operation:one",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    expect((await index.assertCreatable(target)).allowed).toBe(false);
    expect((await index.commit(checkpoint)).state).toBe("committed");
    expect((await index.assertCreatable(target)).allowed).toBe(false);
    first.close();

    const reopened = new NodeSqliteTestDatabase(indexPath);
    const recovered = createSqliteDeletionIndex(reopened, config);
    expect((await recovered.inspect()).generation).toBe(1);
    expect((await recovered.assertCreatable(target)).allowed).toBe(false);
    const pending = (await recovered.inspect()).pendingCheckpoint;
    if (pending === null) throw new Error("Expected a committed checkpoint after reopen.");
    const contentStarted = await recovered.startContent(pending);
    await recovered.completeContent(contentStarted);
    expect((await recovered.inspect()).pendingCheckpoint).toBeNull();
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves a prepared checkpoint as pending after reopening", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config);
    const evidence: SqliteAuditIndexEvidence = createSqliteAuditIndexEvidence(database, config);
    const evidenceRequest: SqliteAuditIndexEvidenceRequest = {
      operationId: "operation:evidence",
      authorityLineage: config.authorityLineage,
      artifactDigest: digest,
      expectedIndexGeneration: 0,
    };
    const evidenceResult: SqliteAuditIndexEvidenceResult = evidence.read(evidenceRequest);
    expect(evidenceResult).toMatchObject({ kind: "no-intent" });
    await index.prepare({
      operationId: "operation:pending",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    expectStorageError(
      () =>
        index.prepare({
          operationId: "operation:blocked-by-pending",
          authorityLineage: config.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [{ ...target, key: { userId: "user:pending-other" } }],
          artifactDigest: digest,
        }),
      "pending-checkpoint",
      "Deletion index has a pending checkpoint.",
    );
    const reopened = createSqliteDeletionIndex(database, config);
    const pending = (await reopened.inspect()).pendingCheckpoint;
    if (pending === null) throw new Error("Expected a pending checkpoint.");
    expect(pending.operationId).toBe("operation:pending");
    expect(
      (await reopened.assertCreatable({ ...target, key: { userId: "user:other" } })).allowed,
    ).toBe(false);
    const uncertain = await reopened.markUncertain(pending);
    expect(uncertain.state).toBe("uncertain");
    expect((await reopened.inspect()).pendingCheckpoint?.state).toBe("uncertain");
    expect((await reopened.assertCreatable(target)).allowed).toBe(false);
    database.close();
  });

  it("reports unavailable evidence for stale bindings and historical checkpoints", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config);
    const evidence = createSqliteAuditIndexEvidence(database, config);
    const request = (operationId: string, expectedIndexGeneration: number) => ({
      operationId,
      authorityLineage: config.authorityLineage,
      artifactDigest: digest,
      expectedIndexGeneration,
    });
    expect(evidence.read(request("operation:none", 0))).toMatchObject({ kind: "no-intent" });
    expect(evidence.read(request("operation:none", 1))).toEqual({ kind: "unavailable" });
    database.execute(
      "UPDATE marea_deletion_index_meta SET state = 'uncertain' WHERE singleton = 1",
    );
    expect(evidence.read(request("operation:none", 0))).toEqual({ kind: "unavailable" });
    database.execute("UPDATE marea_deletion_index_meta SET state = 'active' WHERE singleton = 1");
    const first = await index.prepare({
      operationId: "operation:first",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    expect(evidence.read(request("operation:missing-while-pending", 0))).toEqual({
      kind: "unavailable",
    });
    expect(evidence.read(request(first.operationId, 0))).toMatchObject({ kind: "no-intent" });
    database.execute("UPDATE marea_deletion_index_meta SET generation = 1 WHERE singleton = 1");
    expect(evidence.read(request(first.operationId, 0))).toEqual({ kind: "unavailable" });
    database.execute("UPDATE marea_deletion_index_meta SET generation = 0 WHERE singleton = 1");
    const committed = await index.commit(first);
    expect(
      evidence.read({ ...request(committed.operationId, 0), artifactDigest: digest + "x" }),
    ).toEqual({
      kind: "unavailable",
    });
    expect(
      evidence.read({ ...request(committed.operationId, 0), authorityLineage: "lineage:other" }),
    ).toEqual({
      kind: "unavailable",
    });
    expect(evidence.read(request(committed.operationId, 1))).toEqual({ kind: "unavailable" });
    await index.completeContent(await index.startContent(committed));
    const second = await index.prepare({
      operationId: "operation:second",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 1,
      targets: [{ ...target, key: { userId: "user:other" } }],
      artifactDigest: digest,
    });
    await index.commit(second);
    expect(evidence.read(request(committed.operationId, 0))).toEqual({ kind: "unavailable" });
    expect(evidence.read(request(second.operationId, 1))).toMatchObject({
      kind: "intent",
      nextIndexGeneration: 2,
      durableIntent: "committed",
    });
    database.close();
  });

  it("rejects foreign authority preparation and reconciles restored identities from the reader", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config, {
      read: () => Promise.resolve([target]),
    });
    expectStorageError(
      () =>
        index.prepare({
          operationId: "operation:foreign",
          authorityLineage: AuthorityLineageSchema.parse("lineage:foreign"),
          expectedIndexGeneration: 0,
          targets: [target],
          artifactDigest: digest,
        }),
      "stale-authority",
      "Deletion authority is stale.",
    );
    const checkpoint = await index.prepare({
      operationId: "operation:reader",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const committed = await index.commit(checkpoint);
    const committedEvidence = createSqliteAuditIndexEvidence(database, config).read({
      operationId: committed.operationId,
      authorityLineage: config.authorityLineage,
      artifactDigest: digest,
      expectedIndexGeneration: 0,
    });
    expect(committedEvidence).toMatchObject({
      kind: "intent",
      contentState: "pending",
      nextIndexGeneration: 1,
    });
    await index.completeContent(await index.startContent(committed));
    const bundleDigest = ManifestSha256Schema.parse("a".repeat(64));
    const identity = restoredIdentity(config, bundleDigest);
    await expect(index.reconcile(identity)).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "tombstoned-identity",
      checked: 1,
    });
    database.close();
  });

  it("fails closed when the durable pending marker is lost", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config);
    await index.prepare({
      operationId: "operation:lost-marker",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    database.execute("UPDATE marea_deletion_index_meta SET pending_checkpoint_json = NULL");
    expect((await index.inspect()).state).toBe("corrupt");
    expectStorageError(
      () => readConsistentInspection(database, config),
      "index-corrupt",
      "Pending checkpoint marker is inconsistent.",
    );
    expect((await index.assertCreatable(target)).allowed).toBe(false);
    database.close();
  });

  it("rejects a regressed generation after a completed deletion", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config);
    const prepared = await index.prepare({
      operationId: "operation:generation",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const committed = await index.commit(prepared);
    await index.completeContent(await index.startContent(committed));
    database.execute("UPDATE marea_deletion_index_meta SET generation = 0 WHERE singleton = 1");
    expect((await index.inspect()).state).toBe("corrupt");
    database.close();
  });

  it("never recreates authority metadata in an existing schema", () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    database.execute("DELETE FROM marea_deletion_index_meta");
    expect(() => {
      initializeDeletionIndex(database, config);
    }).toThrow(DeletionIndexStorageError);
    database.close();
  });

  it("revalidates authority after deferred restored-target enumeration", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const other: TargetRef = {
      kind: "account",
      key: { userId: "user:race" },
      observed: { kind: "version", version: "v1" },
    };
    let release: ((targets: readonly TargetRef[]) => void) | undefined;
    const index = createSqliteDeletionIndex(database, config, {
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const bundleDigest = ManifestSha256Schema.parse("b".repeat(64));
    const identity = restoredIdentity(config, bundleDigest);
    const reconciliation = index.reconcile(identity);
    await Promise.resolve();
    const checkpoint = await index.prepare({
      operationId: "operation:race",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [other],
      artifactDigest: digest,
    });
    await index.commit(checkpoint);
    release?.([other]);
    await expect(reconciliation).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "pending-checkpoint",
    });
    database.close();
  });

  it("fails closed for unknown roots, aliased parents, and hardlinked storage files", () => {
    const missingParent = mkdtempSync(join(tmpdir(), "marea-operations-missing-parent-"));
    const missingRoot = join(missingParent, "missing");
    const missingConfiguration = parseStorageConfiguration({
      ...configuration,
      installationRoot: missingRoot,
      databasePath: join(missingRoot, "application.sqlite"),
      indexPath: join(missingRoot, "deletion-index.sqlite"),
    });
    expect(() => {
      initializeDeletionIndex(new NodeSqliteTestDatabase(), missingConfiguration);
    }).toThrow("physically verified");

    const physicalRoot = mkdtempSync(join(tmpdir(), "marea-operations-physical-root-"));
    const rootAlias = join(dirname(physicalRoot), `${basename(physicalRoot)}-alias`);
    symlinkSync(physicalRoot, rootAlias, "dir");
    const aliasedRootConfiguration = parseStorageConfiguration({
      ...configuration,
      installationRoot: rootAlias,
      databasePath: join(rootAlias, "application.sqlite"),
      indexPath: join(rootAlias, "deletion-index.sqlite"),
    });
    expect(() => {
      initializeDeletionIndex(new NodeSqliteTestDatabase(), aliasedRootConfiguration);
    }).toThrow("physically verified");

    const parentAlias = join(dirname(physicalRoot), `${basename(physicalRoot)}-parent-alias`);
    symlinkSync(physicalRoot, parentAlias, "dir");
    const aliasedParentConfiguration = parseStorageConfiguration({
      ...configuration,
      installationRoot: physicalRoot,
      databasePath: join(parentAlias, "application.sqlite"),
      indexPath: join(parentAlias, "deletion-index.sqlite"),
    });
    expect(() => {
      initializeDeletionIndex(new NodeSqliteTestDatabase(), aliasedParentConfiguration);
    }).toThrow("under installation root");

    const hardlinkRoot = mkdtempSync(join(tmpdir(), "marea-operations-hardlink-root-"));
    const original = join(hardlinkRoot, "original.sqlite");
    const hardlinkedDatabase = join(hardlinkRoot, "application.sqlite");
    writeFileSync(original, "not-a-database");
    linkSync(original, hardlinkedDatabase);
    const hardlinkConfiguration = parseStorageConfiguration({
      ...configuration,
      installationRoot: hardlinkRoot,
      databasePath: hardlinkedDatabase,
      indexPath: join(hardlinkRoot, "deletion-index.sqlite"),
    });
    expect(() => {
      initializeDeletionIndex(new NodeSqliteTestDatabase(), hardlinkConfiguration);
    }).toThrow("regular file");

    rmSync(missingParent, { recursive: true, force: true });
    rmSync(rootAlias, { force: true });
    rmSync(parentAlias, { force: true });
    rmSync(physicalRoot, { recursive: true, force: true });
    rmSync(hardlinkRoot, { recursive: true, force: true });
  });

  it("rejects malformed path values and unresolved storage parents", () => {
    const root = mkdtempSync(join(tmpdir(), "marea-operations-path-validation-"));
    const base = {
      ...configuration,
      installationRoot: root,
      databasePath: join(root, "application.sqlite"),
      indexPath: join(root, "deletion-index.sqlite"),
    };
    let relativePathError: unknown;
    try {
      parseStorageConfiguration({ ...base, databasePath: "relative.sqlite" });
    } catch (error) {
      relativePathError = error;
    }
    expect(relativePathError).toMatchObject({
      issues: [{ path: ["databasePath"], message: "path must be an absolute persistent path" }],
    });
    expect(() =>
      parseStorageConfiguration({ ...base, databasePath: join(root, "bad\0name") }),
    ).toThrow();
    expect(() =>
      parseStorageConfiguration({ ...base, databasePath: join(root, "é".repeat(3_000)) }),
    ).toThrow();
    const exactLimitPath = "/" + "a".repeat(4_095);
    expect(
      parseStorageConfiguration({
        ...base,
        installationRoot: exactLimitPath,
        databasePath: exactLimitPath.slice(0, -1) + "b",
        indexPath: exactLimitPath.slice(0, -1) + "c",
      }).databasePath,
    ).toBe(exactLimitPath.slice(0, -1) + "b");
    expect(() =>
      parseStorageConfiguration({
        ...base,
        databasePath: join(root, "same.sqlite"),
        indexPath: join(root, ".", "same.sqlite"),
      }),
    ).toThrow("paths must differ");
    let equalPathError: unknown;
    try {
      parseStorageConfiguration({
        ...base,
        databasePath: join(root, "same-exact.sqlite"),
        indexPath: join(root, ".", "same-exact.sqlite"),
      });
    } catch (error) {
      equalPathError = error;
    }
    expect(equalPathError).toMatchObject({
      issues: [
        { code: "custom", path: ["indexPath"], message: "database and index paths must differ" },
      ],
    });

    const missingParentConfiguration = parseStorageConfiguration({
      ...base,
      databasePath: join(root, "missing", "application.sqlite"),
      indexPath: join(root, "missing", "deletion-index.sqlite"),
    });
    expect(() => {
      initializeDeletionIndex(new NodeSqliteTestDatabase(), missingParentConfiguration);
    }).toThrow("parent cannot be physically verified");

    const rootFile = join(root, "root-file");
    writeFileSync(rootFile, "not-a-directory");
    const fileRootConfiguration = parseStorageConfiguration({
      ...base,
      installationRoot: rootFile,
      databasePath: join(rootFile, "application.sqlite"),
      indexPath: join(rootFile, "deletion-index.sqlite"),
    });
    expect(() => {
      initializeDeletionIndex(new NodeSqliteTestDatabase(), fileRootConfiguration);
    }).toThrow("installation root cannot be physically verified");
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a parent symlink inside the root when its target escapes the root", () => {
    const root = mkdtempSync(join(tmpdir(), "marea-operations-root-"));
    const outside = mkdtempSync(join(tmpdir(), "marea-operations-outside-"));
    const parentAlias = join(root, "storage-parent");
    symlinkSync(outside, parentAlias, "dir");
    const aliasedParentConfiguration = parseStorageConfiguration({
      ...configuration,
      installationRoot: root,
      databasePath: join(parentAlias, "application.sqlite"),
      indexPath: join(parentAlias, "deletion-index.sqlite"),
    });
    expect(() => {
      initializeDeletionIndex(new NodeSqliteTestDatabase(), aliasedParentConfiguration);
    }).toThrow("under installation root");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("fails closed when a committed tombstone payload no longer matches its checkpoint", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config);
    const committed = await index.commit(
      await index.prepare({
        operationId: "operation:payload-drift",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    database.execute(
      "UPDATE marea_deletion_index_tombstones SET target_json = ?1 WHERE operation_id = ?2",
      [
        JSON.stringify({
          ...target,
          observed: { kind: "version", version: "v2" },
        }),
        committed.operationId,
      ],
    );
    expect((await index.inspect()).state).toBe("corrupt");
    database.close();
  });

  it("reports missing authority on an empty database and corruption when metadata is deleted", async () => {
    const empty = new NodeSqliteTestDatabase();
    const missing = createSqliteDeletionIndex(empty, configuration);
    expect(await missing.inspect()).toMatchObject({ state: "corrupt", generation: 0 });
    expect(await missing.assertCreatable(target)).toEqual({
      allowed: false,
      code: "corrupt",
    });
    empty.close();

    const database = new NodeSqliteTestDatabase();
    initializeDeletionIndex(database, configuration);
    database.execute("DELETE FROM marea_deletion_index_meta");
    const corrupt = createSqliteDeletionIndex(database, configuration);
    expect((await corrupt.inspect()).state).toBe("corrupt");
    database.close();
  });

  it("requires exact durable evidence and exact disposition observations", () => {
    const database = schemaEightDatabase();
    activateApplicationAuditSchema(database);
    let evidenceResult: AuditIndexEvidenceResult = { kind: "unavailable" };
    const stores = createApplicationAuditStores(database, {
      read: () => evidenceResult,
    });
    const value = artifact();
    stores.audit.recordPrepared(value, value.createdAt);

    expect(() => {
      stores.audit.advance({
        operationId: value.previewId,
        expectedState: "prepared",
        nextState: "failed",
        now: value.createdAt,
        errorCode: "unavailable",
      });
    }).toThrow("no-intent");
    expect(() => {
      stores.audit.advance({
        operationId: value.previewId,
        expectedState: "prepared",
        nextState: "index-committed",
        now: value.createdAt,
      });
    }).toThrow("State completion requires verified durable index intent.");

    evidenceResult = {
      kind: "intent",
      operationId: value.previewId,
      authorityLineage: value.authorityLineage,
      artifactDigest: value.artifactDigest,
      expectedIndexGeneration: value.expectedIndexGeneration,
      nextIndexGeneration: 9,
      state: "committed",
      contentState: "pending",
      durableIntent: "committed",
    };
    expect(() => {
      stores.audit.advance({
        operationId: value.previewId,
        expectedState: "prepared",
        nextState: "index-committed",
        now: value.createdAt,
      });
    }).toThrow("State completion requires matching durable index intent.");

    evidenceResult = {
      ...evidenceResult,
      nextIndexGeneration: value.expectedIndexGeneration + 1,
    };
    stores.audit.advance({
      operationId: value.previewId,
      expectedState: "prepared",
      nextState: "index-committed",
      now: value.createdAt,
    });
    evidenceResult = { ...evidenceResult, contentState: "in-progress" };
    stores.audit.advance({
      operationId: value.previewId,
      expectedState: "index-committed",
      nextState: "content-started",
      now: value.createdAt,
    });

    expect(() => {
      stores.dispositions.record("operation:missing", {
        target,
        disposition: "deleted",
        updatedAt: value.createdAt,
      });
    }).toThrow("does not exist");
    expect(() => {
      stores.dispositions.record(value.previewId, {
        target: { ...target, observed: { kind: "version", version: "v2" } },
        disposition: "deleted",
        updatedAt: value.createdAt,
      });
    }).toThrow("Content disposition does not match planned observation.");
    expect(() => {
      stores.dispositions.record(value.previewId, {
        target: { ...target, key: { userId: "user:not-planned" } },
        disposition: "deleted",
        updatedAt: value.createdAt,
      });
    }).toThrow("Content disposition target is not planned.");
    stores.dispositions.record(value.previewId, {
      target,
      disposition: "deleted",
      updatedAt: value.createdAt,
    });
    expect(stores.dispositions.list(value.previewId)).toHaveLength(1);
    database.close();
  });

  it("rejects missing audit operations and persists explicit error/detail values", () => {
    const database = schemaEightDatabase();
    activateApplicationAuditSchema(database);
    const value = artifact();
    expect(new DeletionIndexStorageError("index-corrupt", "message").name).toBe(
      "DeletionIndexStorageError",
    );
    const stores = createApplicationAuditStores(database, {
      read: (input) => ({
        kind: "no-intent" as const,
        operationId: input.operationId,
        authorityLineage: input.authorityLineage,
        artifactDigest: input.artifactDigest,
        expectedIndexGeneration: input.expectedIndexGeneration,
      }),
    });
    expect(() => {
      stores.audit.advance({
        operationId: "operation:missing",
        expectedState: "prepared",
        nextState: "failed",
        now: value.createdAt,
      });
    }).toThrow("does not exist");
    stores.audit.recordPrepared(value, value.createdAt);
    stores.audit.advance({
      operationId: value.previewId,
      expectedState: "prepared",
      nextState: "failed",
      now: "2026-09-13T10:01:00.000Z",
      errorCode: "interrupted",
    });
    expect(stores.audit.read(value.previewId)).toMatchObject({
      state: "failed",
      errorCode: "interrupted",
      updatedAt: "2026-09-13T10:01:00.000Z",
    });
    database.close();

    const detailDatabase = schemaEightDatabase();
    activateApplicationAuditSchema(detailDatabase);
    const detailStores = createApplicationAuditStores(detailDatabase, {
      read: () => ({ kind: "unavailable" }),
    });
    detailStores.audit.recordPrepared(value, value.createdAt);
    detailStores.dispositions.record(value.previewId, {
      target,
      disposition: "blocked",
      detailCode: "manual-review",
      updatedAt: value.createdAt,
    });
    expect(detailStores.dispositions.list(value.previewId)[0]).toMatchObject({
      detailCode: "manual-review",
      disposition: "blocked",
    });
    detailDatabase.close();
  });

  it("canonicalizes regular files and rejects unresolved or non-directory parents", () => {
    const root = mkdtempSync(join(tmpdir(), "marea-operations-canonical-paths-"));
    const existingDatabase = join(root, "existing.sqlite");
    writeFileSync(existingDatabase, "regular");
    const canonical = canonicalizeStorageConfiguration(
      parseStorageConfiguration({
        ...configuration,
        installationRoot: root,
        databasePath: existingDatabase,
        indexPath: join(root, "index.sqlite"),
      }),
    );
    const canonicalRoot = realpathSync.native(root);
    expect(canonical.databasePath).toBe(join(canonicalRoot, "existing.sqlite"));
    expect(canonical.indexPath).toBe(join(canonicalRoot, "index.sqlite"));

    const missingParent = parseStorageConfiguration({
      ...configuration,
      installationRoot: root,
      databasePath: join(root, "missing", "database.sqlite"),
      indexPath: join(root, "missing", "index.sqlite"),
    });
    expect(() => canonicalizeStorageConfiguration(missingParent)).toThrow(
      "parent cannot be physically verified",
    );

    const fileParent = join(root, "file-parent");
    writeFileSync(fileParent, "not-a-directory");
    const nonDirectoryParent = parseStorageConfiguration({
      ...configuration,
      installationRoot: root,
      databasePath: join(fileParent, "database.sqlite"),
      indexPath: join(fileParent, "index.sqlite"),
    });
    expect(() => canonicalizeStorageConfiguration(nonDirectoryParent)).toThrow(
      "parent cannot be physically verified",
    );

    const symlinkLeaf = join(root, "symlink.sqlite");
    symlinkSync(existingDatabase, symlinkLeaf, "file");
    const symlinkLeafConfiguration = parseStorageConfiguration({
      ...configuration,
      installationRoot: root,
      databasePath: symlinkLeaf,
      indexPath: join(root, "index-symlink.sqlite"),
    });
    expect(() => canonicalizeStorageConfiguration(symlinkLeafConfiguration)).toThrow(
      "cannot be symbolic link",
    );

    const directoryLeaf = join(root, "directory.sqlite");
    mkdirSync(directoryLeaf);
    const directoryLeafConfiguration = parseStorageConfiguration({
      ...configuration,
      installationRoot: root,
      databasePath: directoryLeaf,
      indexPath: join(root, "index-directory.sqlite"),
    });
    expect(() => canonicalizeStorageConfiguration(directoryLeafConfiguration)).toThrow(
      "regular file",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects distinct lexical paths that canonicalize to one storage target", () => {
    const root = mkdtempSync(join(tmpdir(), "marea-operations-canonical-equal-"));
    const inner = join(root, "inner");
    const alias = join(root, "alias");
    writeFileSync(join(root, "placeholder"), "root");
    mkdirSync(inner);
    symlinkSync(inner, alias, "dir");
    const config = parseStorageConfiguration({
      ...configuration,
      installationRoot: root,
      databasePath: join(inner, "same.sqlite"),
      indexPath: join(alias, "same.sqlite"),
    });
    expect(() => canonicalizeStorageConfiguration(config)).toThrow("paths must differ");
    rmSync(root, { recursive: true, force: true });
  });

  it("reports uncertain and completed durable evidence states", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config);
    const prepared = await index.prepare({
      operationId: "operation:evidence-states",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const committed = await index.commit(prepared);
    const evidence = createSqliteAuditIndexEvidence(database, config);
    expect(
      evidence.read({
        operationId: committed.operationId,
        authorityLineage: config.authorityLineage,
        artifactDigest: digest,
        expectedIndexGeneration: 0,
      }),
    ).toMatchObject({ kind: "intent", state: "committed", contentState: "pending" });
    const complete = await index.completeContent(await index.startContent(committed));
    expect(
      evidence.read({
        operationId: complete.operationId,
        authorityLineage: config.authorityLineage,
        artifactDigest: digest,
        expectedIndexGeneration: 0,
      }),
    ).toMatchObject({ kind: "intent", state: "committed", contentState: "complete" });
    database.close();

    const uncertainDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(uncertainDatabase, config);
    const uncertainIndex = createSqliteDeletionIndex(uncertainDatabase, config);
    const uncertainPrepared = await uncertainIndex.prepare({
      operationId: "operation:evidence-uncertain",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const uncertain = await uncertainIndex.markUncertain(
      await uncertainIndex.commit(uncertainPrepared),
    );
    const uncertainEvidence = createSqliteAuditIndexEvidence(uncertainDatabase, config);
    expect(
      uncertainEvidence.read({
        operationId: uncertain.operationId,
        authorityLineage: config.authorityLineage,
        artifactDigest: digest,
        expectedIndexGeneration: 0,
      }),
    ).toMatchObject({ kind: "intent", state: "uncertain", contentState: "pending" });
    const gate = createSqliteCreationGate(uncertainDatabase, config);
    expect(gate.check(target)).toEqual({ allowed: false, code: "uncertain" });
    expect(gate.check(target)).toEqual(await uncertainIndex.assertCreatable(target));
    uncertainDatabase.execute("UPDATE marea_deletion_index_meta SET generation = 5");
    expect(gate.check(target)).toEqual({ allowed: false, code: "corrupt" });
    uncertainDatabase.execute("UPDATE marea_deletion_index_meta SET generation = 1");
    const resumed = await uncertainIndex.resumeContent(uncertain);
    expect(resumed).toMatchObject({
      state: "committed",
      contentState: "in-progress",
      durableIntent: "committed",
    });
    expect((await uncertainIndex.inspect()).pendingCheckpoint).toEqual(resumed);
    await expect(
      Promise.resolve().then(() => uncertainIndex.resumeContent(resumed)),
    ).rejects.toThrow("Index checkpoint transition is invalid.");
    await uncertainIndex.completeContent(resumed);
    expect((await uncertainIndex.inspect()).pendingCheckpoint).toBeNull();
    uncertainDatabase.close();
  });

  it("fails closed for malformed checkpoint rows and independent pending records", async () => {
    const expectCorrupt = (
      mutate: (database: NodeSqliteTestDatabase, checkpoint: IndexCheckpoint) => void,
      message: string,
    ) => {
      const database = new NodeSqliteTestDatabase();
      const config = { ...configuration };
      initializeDeletionIndex(database, config);
      return createSqliteDeletionIndex(database, config)
        .prepare({
          operationId: "operation:malformed",
          authorityLineage: config.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [target],
          artifactDigest: digest,
        })
        .then((checkpoint) => {
          mutate(database, checkpoint);
          expect(() => readConsistentInspection(database, config)).toThrow(message);
          database.close();
        });
    };
    await expectCorrupt((database) => {
      database.execute("UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1", [
        "null",
      ]);
    }, "Checkpoint data");
    await expectCorrupt((database) => {
      database.execute("UPDATE marea_deletion_index_checkpoints SET targets_json = ?1", ["{}"]);
    }, "Target data");
    await expectCorrupt((database) => {
      database.execute("UPDATE marea_deletion_index_checkpoints SET operation_id = ?1", [
        "operation:row-id",
      ]);
    }, "Checkpoint data is inconsistent");
    await expectCorrupt((database, checkpoint) => {
      database.execute(
        "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
        [
          JSON.stringify({ ...checkpoint, authorityLineage: "lineage:foreign" }),
          checkpoint.operationId,
        ],
      );
    }, "Checkpoint data is inconsistent");
    await expectCorrupt((database) => {
      database.execute("UPDATE marea_deletion_index_checkpoints SET targets_json = ?1", [
        JSON.stringify([target, target]),
      ]);
    }, "Checkpoint data is inconsistent");

    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config);
    const first = await index.prepare({
      operationId: "operation:pending-one",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const second = IndexCheckpointSchema.parse({
      ...first,
      operationId: "operation:pending-two",
    });
    database.execute(
      "INSERT INTO marea_deletion_index_checkpoints (operation_id, checkpoint_json, targets_json) VALUES (?1, ?2, ?3)",
      [second.operationId, JSON.stringify(second), JSON.stringify([target])],
    );
    expect(() => readConsistentInspection(database, config)).toThrow("Multiple pending");
    database.close();
  });

  it("validates generation chain and tombstone relationships independently", async () => {
    const chain = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(chain, config);
    const index = createSqliteDeletionIndex(chain, config);
    const committed = await index.commit(
      await index.prepare({
        operationId: "operation:chain",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    chain.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [
        JSON.stringify({ ...committed, expectedIndexGeneration: 2, nextIndexGeneration: 3 }),
        committed.operationId,
      ],
    );
    chain.execute(
      "UPDATE marea_deletion_index_meta SET generation = 3, pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify({ ...committed, expectedIndexGeneration: 2, nextIndexGeneration: 3 })],
    );
    expectStorageError(
      () => readConsistentInspection(chain, config),
      "index-corrupt",
      "Generation chain is inconsistent.",
    );
    chain.close();

    const nextGenerationDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(nextGenerationDb, config);
    const nextGenerationIndex = createSqliteDeletionIndex(nextGenerationDb, config);
    const nextGeneration = await nextGenerationIndex.commit(
      await nextGenerationIndex.prepare({
        operationId: "operation:wrong-next-generation",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    nextGenerationDb.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [JSON.stringify({ ...nextGeneration, nextIndexGeneration: 2 }), nextGeneration.operationId],
    );
    nextGenerationDb.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify({ ...nextGeneration, nextIndexGeneration: 2 })],
    );
    expectStorageError(
      () => readConsistentInspection(nextGenerationDb, config),
      "index-corrupt",
      "Generation chain is inconsistent.",
    );
    nextGenerationDb.close();

    const expectedGenerationDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(expectedGenerationDb, config);
    const expectedGenerationIndex = createSqliteDeletionIndex(expectedGenerationDb, config);
    const expectedGeneration = await expectedGenerationIndex.commit(
      await expectedGenerationIndex.prepare({
        operationId: "operation:wrong-expected-generation",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    expectedGenerationDb.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [
        JSON.stringify({
          ...expectedGeneration,
          expectedIndexGeneration: 1,
          nextIndexGeneration: 2,
        }),
        expectedGeneration.operationId,
      ],
    );
    expectedGenerationDb.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [
        JSON.stringify({
          ...expectedGeneration,
          expectedIndexGeneration: 1,
          nextIndexGeneration: 2,
        }),
      ],
    );
    expectStorageError(
      () => readConsistentInspection(expectedGenerationDb, config),
      "index-corrupt",
      "Generation chain is inconsistent.",
    );
    expectedGenerationDb.close();

    const belowGenerationDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(belowGenerationDb, config);
    const belowGenerationIndex = createSqliteDeletionIndex(belowGenerationDb, config);
    const firstGeneration = await belowGenerationIndex.commit(
      await belowGenerationIndex.prepare({
        operationId: "operation:below-generation-first",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    await belowGenerationIndex.completeContent(
      await belowGenerationIndex.startContent(firstGeneration),
    );
    const secondGeneration = await belowGenerationIndex.prepare({
      operationId: "operation:below-generation-second",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 1,
      targets: [{ ...target, key: { userId: "user:below-generation" } }],
      artifactDigest: digest,
    });
    const staleBelow = { ...secondGeneration, expectedIndexGeneration: 0, nextIndexGeneration: 1 };
    belowGenerationDb.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [JSON.stringify(staleBelow), secondGeneration.operationId],
    );
    belowGenerationDb.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify(staleBelow)],
    );
    expectStorageError(
      () => readConsistentInspection(belowGenerationDb, config),
      "index-corrupt",
      "Checkpoint generation is stale.",
    );
    belowGenerationDb.close();

    const orderedChainDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(orderedChainDb, config);
    const orderedChainIndex = createSqliteDeletionIndex(orderedChainDb, config);
    const first = await orderedChainIndex.commit(
      await orderedChainIndex.prepare({
        operationId: "operation:ordered-first",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    await orderedChainIndex.completeContent(await orderedChainIndex.startContent(first));
    expect(
      orderedChainDb.readOne(
        "SELECT pending_checkpoint_json FROM marea_deletion_index_meta WHERE singleton = 1",
      ),
    ).toEqual({ pending_checkpoint_json: null });
    const failedCheckpoint = await orderedChainIndex.failBeforeIntent(
      await orderedChainIndex.prepare({
        operationId: "operation:z-failed",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 1,
        targets: [{ ...target, key: { userId: "user:failed" } }],
        artifactDigest: digest,
      }),
    );
    expect(failedCheckpoint.state).toBe("failed");
    expect(
      orderedChainDb.readOne(
        "SELECT pending_checkpoint_json FROM marea_deletion_index_meta WHERE singleton = 1",
      ),
    ).toEqual({ pending_checkpoint_json: null });
    const secondTarget = { ...target, key: { userId: "user:ordered-second" } };
    const second = await orderedChainIndex.commit(
      await orderedChainIndex.prepare({
        operationId: "operation:a-ordered-second",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 1,
        targets: [secondTarget],
        artifactDigest: digest,
      }),
    );
    await orderedChainIndex.completeContent(await orderedChainIndex.startContent(second));
    expect(
      orderedChainDb.readOne(
        "SELECT pending_checkpoint_json FROM marea_deletion_index_meta WHERE singleton = 1",
      ),
    ).toEqual({ pending_checkpoint_json: null });
    expect(readConsistentInspection(orderedChainDb, config).generation).toBe(2);
    const committedWithContentComplete = await orderedChainIndex.completeContent(
      await orderedChainIndex.startContent(
        await orderedChainIndex.commit(
          await orderedChainIndex.prepare({
            operationId: "operation:committed-complete",
            authorityLineage: config.authorityLineage,
            expectedIndexGeneration: 2,
            targets: [{ ...target, key: { userId: "user:complete" } }],
            artifactDigest: digest,
          }),
        ),
      ),
    );
    const uncertainComplete = { ...committedWithContentComplete, state: "uncertain" as const };
    orderedChainDb.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [JSON.stringify(uncertainComplete), committedWithContentComplete.operationId],
    );
    orderedChainDb.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify(uncertainComplete)],
    );
    expect(readConsistentInspection(orderedChainDb, config).state).toBe("active");
    orderedChainDb.close();

    const replayDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(replayDb, config);
    const replayIndex = createSqliteDeletionIndex(replayDb, config);
    const replayFirst = await replayIndex.commit(
      await replayIndex.prepare({
        operationId: "operation:replay-first",
        authorityLineage: config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    const replayFirstComplete = await replayIndex.completeContent(
      await replayIndex.startContent(replayFirst),
    );
    await replayIndex.completeContent(
      await replayIndex.startContent(
        await replayIndex.commit(
          await replayIndex.prepare({
            operationId: "operation:replay-second",
            authorityLineage: config.authorityLineage,
            expectedIndexGeneration: 1,
            targets: [{ ...target, key: { userId: "user:replay-second" } }],
            artifactDigest: digest,
          }),
        ),
      ),
    );
    expectStorageError(
      () => replayIndex.commit(replayFirstComplete),
      "stale-authority",
      "Deletion authority is stale.",
    );
    replayDb.close();

    const failedDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(failedDb, config);
    const failedIndex = createSqliteDeletionIndex(failedDb, config);
    const prepared = await failedIndex.prepare({
      operationId: "operation:failed-generation",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const failed = await failedIndex.failBeforeIntent(prepared);
    failedDb.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [
        JSON.stringify({ ...failed, expectedIndexGeneration: 1, nextIndexGeneration: 2 }),
        failed.operationId,
      ],
    );
    expect(() => readConsistentInspection(failedDb, config)).toThrow("generation is stale");
    failedDb.close();

    const staleDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(staleDb, config);
    const staleIndex = createSqliteDeletionIndex(staleDb, config);
    const stale = await staleIndex.prepare({
      operationId: "operation:prepared-generation",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const staleCheckpoint = { ...stale, expectedIndexGeneration: 1, nextIndexGeneration: 2 };
    staleDb.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [JSON.stringify(staleCheckpoint), stale.operationId],
    );
    staleDb.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify(staleCheckpoint)],
    );
    expect(() => readConsistentInspection(staleDb, config)).toThrow("generation is stale");
    staleDb.close();
  });

  it("fails closed for orphaned, foreign, malformed, and incomplete tombstones", async () => {
    const makeCommitted = async (operationId: string) => {
      const database = new NodeSqliteTestDatabase();
      const config = { ...configuration };
      initializeDeletionIndex(database, config);
      const index = createSqliteDeletionIndex(database, config);
      const checkpoint = await index.commit(
        await index.prepare({
          operationId,
          authorityLineage: config.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [target],
          artifactDigest: digest,
        }),
      );
      return { database, config, checkpoint };
    };

    const preparedDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(preparedDb, configuration);
    const preparedIndex = createSqliteDeletionIndex(preparedDb, configuration);
    const prepared = await preparedIndex.prepare({
      operationId: "operation:prepared-tombstone",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    preparedDb.execute(
      "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [
        configuration.authorityLineage,
        target.kind,
        targetIdentity(target),
        JSON.stringify(target),
        prepared.operationId,
        "2026-09-13T10:00:00.000Z",
      ],
    );
    expect(() => readConsistentInspection(preparedDb, configuration)).toThrow(
      "Prepared checkpoint",
    );
    preparedDb.close();

    const orphan = await makeCommitted("operation:orphan-tombstone");
    orphan.database.execute(
      "UPDATE marea_deletion_index_tombstones SET operation_id = ?1 WHERE operation_id = ?2",
      ["operation:other", orphan.checkpoint.operationId],
    );
    expect(() => readConsistentInspection(orphan.database, orphan.config)).toThrow(
      "no matching checkpoint",
    );
    orphan.database.close();

    const foreign = await makeCommitted("operation:foreign-tombstone");
    foreign.database.execute(
      "UPDATE marea_deletion_index_tombstones SET authority_lineage = ?1 WHERE operation_id = ?2",
      ["lineage:foreign", foreign.checkpoint.operationId],
    );
    expect(() => readConsistentInspection(foreign.database, foreign.config)).toThrow(
      "no matching checkpoint",
    );
    foreign.database.close();

    const malformed = await makeCommitted("operation:malformed-tombstone");
    malformed.database.execute(
      "UPDATE marea_deletion_index_tombstones SET target_json = ?1 WHERE operation_id = ?2",
      ["null", malformed.checkpoint.operationId],
    );
    expectStorageError(
      () => readConsistentInspection(malformed.database, malformed.config),
      "index-corrupt",
      "Index data is invalid.",
    );
    malformed.database.close();

    const kindMismatch = await makeCommitted("operation:kind-tombstone");
    kindMismatch.database.execute(
      "UPDATE marea_deletion_index_tombstones SET target_kind = ?1 WHERE operation_id = ?2",
      ["center", kindMismatch.checkpoint.operationId],
    );
    expect(() => readConsistentInspection(kindMismatch.database, kindMismatch.config)).toThrow(
      "identity is inconsistent",
    );
    kindMismatch.database.close();

    const missing = await makeCommitted("operation:missing-tombstone");
    missing.database.execute(
      "DELETE FROM marea_deletion_index_tombstones WHERE operation_id = ?1",
      [missing.checkpoint.operationId],
    );
    expect(() => readConsistentInspection(missing.database, missing.config)).toThrow("incomplete");
    missing.database.close();

    const wrongKey = await makeCommitted("operation:wrong-key-tombstone");
    const other: TargetRef = {
      kind: "account",
      key: { userId: "user:other" },
      observed: { kind: "version", version: "v1" },
    };
    wrongKey.database.execute(
      "UPDATE marea_deletion_index_tombstones SET logical_key = ?1, target_json = ?2 WHERE operation_id = ?3",
      [targetIdentity(other), JSON.stringify(other), wrongKey.checkpoint.operationId],
    );
    expect(() => readConsistentInspection(wrongKey.database, wrongKey.config)).toThrow(
      "incomplete",
    );
    wrongKey.database.close();
  });

  it("rejects stale authority, duplicate identities, and inconsistent pending markers", async () => {
    const staleDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(staleDb, configuration);
    staleDb.execute("UPDATE marea_deletion_index_meta SET root_id = ?1 WHERE singleton = 1", [
      "root:other",
    ]);
    expect(() => readConsistentInspection(staleDb, configuration)).toThrow("Configured authority");
    staleDb.close();

    const duplicate = new NodeSqliteTestDatabase();
    initializeDeletionIndex(duplicate, configuration);
    const duplicateIndex = createSqliteDeletionIndex(duplicate, configuration);
    expectStorageError(
      () =>
        duplicateIndex.prepare({
          operationId: "operation:duplicate-targets",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [target, target],
          artifactDigest: digest,
        }),
      "tombstoned-identity",
      "Deletion targets contain duplicate identities.",
    );
    const first = await duplicateIndex.commit(
      await duplicateIndex.prepare({
        operationId: "operation:first-tombstone",
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    await duplicateIndex.completeContent(await duplicateIndex.startContent(first));
    expect(() =>
      duplicateIndex.prepare({
        operationId: "operation:already-tombstoned",
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 1,
        targets: [target],
        artifactDigest: digest,
      }),
    ).toThrow("already tombstoned");
    duplicate.close();

    const pendingDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(pendingDb, configuration);
    const pendingIndex = createSqliteDeletionIndex(pendingDb, configuration);
    const pending = await pendingIndex.prepare({
      operationId: "operation:pending-marker",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    pendingDb.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify({ ...pending, artifactDigest: "sha256:" + "b".repeat(64) })],
    );
    expectStorageError(
      () => readConsistentInspection(pendingDb, configuration),
      "index-corrupt",
      "Pending checkpoint marker is inconsistent.",
    );
    pendingDb.close();

    const orphanMarkerDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(orphanMarkerDb, configuration);
    const orphanMarkerIndex = createSqliteDeletionIndex(orphanMarkerDb, configuration);
    const committed = await orphanMarkerIndex.commit(
      await orphanMarkerIndex.prepare({
        operationId: "operation:orphan-marker",
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    const complete = await orphanMarkerIndex.completeContent(
      await orphanMarkerIndex.startContent(committed),
    );
    orphanMarkerDb.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify(complete)],
    );
    expect(() => readConsistentInspection(orphanMarkerDb, configuration)).toThrow("orphaned");
    orphanMarkerDb.close();
  });

  it("validates checkpoint state invariants before recovery decisions", async () => {
    const database = new NodeSqliteTestDatabase();
    initializeDeletionIndex(database, configuration);
    const index = createSqliteDeletionIndex(database, configuration);
    for (const [stateIndex, contentState] of ["in-progress", "complete"].entries()) {
      const prepared = await index.prepare({
        operationId: `operation:invalid-state-${String(stateIndex)}`,
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      });
      const invalid = {
        ...prepared,
        state: "uncertain" as const,
        contentState: contentState as "in-progress" | "complete",
        durableIntent: "none" as const,
      };
      database.execute(
        "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
        [JSON.stringify(invalid), prepared.operationId],
      );
      database.execute(
        "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
        [JSON.stringify(invalid)],
      );
      expect(() => readConsistentInspection(database, configuration)).toThrow(
        "Checkpoint state is inconsistent.",
      );
      database.execute("DELETE FROM marea_deletion_index_checkpoints WHERE operation_id = ?1", [
        prepared.operationId,
      ]);
      database.execute(
        "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = NULL WHERE singleton = 1",
      );
    }
    database.close();

    const noTables = new NodeSqliteTestDatabase();
    expect(() => readConsistentInspection(noTables, configuration)).toThrow();
    noTables.close();
  });

  it("covers stale and invalid transition guards at the durable index boundary", async () => {
    const database = new NodeSqliteTestDatabase();
    initializeDeletionIndex(database, configuration);
    const index = createSqliteDeletionIndex(database, configuration);
    expectStorageError(
      () =>
        index.prepare({
          operationId: "operation:stale-generation",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 1,
          targets: [target],
          artifactDigest: digest,
        }),
      "stale-authority",
      "Deletion authority is stale.",
    );
    const prepared = await index.prepare({
      operationId: "operation:invalid-commit",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    expectStorageError(
      () => index.commit({ ...prepared, operationId: "operation:missing" }),
      "invalid-transition",
      "Index checkpoint is not current.",
    );
    const failed = await index.failBeforeIntent(prepared);
    expectStorageError(
      () => index.commit(failed),
      "invalid-transition",
      "Index checkpoint cannot be committed.",
    );
    database.execute(
      "UPDATE marea_deletion_index_meta SET state = 'uncertain' WHERE singleton = 1",
    );
    expect(await index.assertCreatable({ ...target, key: { userId: "user:other" } })).toEqual({
      allowed: false,
      code: "uncertain",
    });
    database.close();

    const staleTransitionDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(staleTransitionDb, configuration);
    const staleTransitionIndex = createSqliteDeletionIndex(staleTransitionDb, configuration);
    const stalePrepared = await staleTransitionIndex.prepare({
      operationId: "operation:stale-transition",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const staleCommitted = await staleTransitionIndex.commit(stalePrepared);
    staleTransitionDb.execute(
      "UPDATE marea_deletion_index_meta SET state = 'uncertain' WHERE singleton = 1",
    );
    expectStorageError(
      () => staleTransitionIndex.startContent(staleCommitted),
      "stale-authority",
      "Deletion authority is stale.",
    );
    staleTransitionDb.close();

    const pendingGuardCheckpoint = IndexCheckpointSchema.parse({
      ...preparedCheckpoint("operation:pending-transition-first"),
      state: "committed",
      durableIntent: "committed",
    });
    const pendingCheckpoint = IndexCheckpointSchema.parse({
      ...preparedCheckpoint("operation:pending-transition-second"),
      expectedIndexGeneration: 1,
      nextIndexGeneration: 2,
    });
    const committedCheckpoint = IndexCheckpointSchema.parse({
      ...pendingGuardCheckpoint,
      state: "committed",
      contentState: "complete",
      durableIntent: "committed",
    });
    const mismatchTransitionDatabase = fakeInspectionDatabase(
      [committedCheckpoint, pendingCheckpoint],
      committedCheckpoint,
      1,
      pendingCheckpoint,
    );
    const mismatchTransitionIndex = createSqliteDeletionIndex(
      mismatchTransitionDatabase,
      configuration,
    );
    expectStorageError(
      () => mismatchTransitionIndex.markUncertain(committedCheckpoint),
      "stale-authority",
      "Deletion authority is stale.",
    );

    const generationCheckpoint = IndexCheckpointSchema.parse({
      ...pendingCheckpoint,
      operationId: "operation:pending-transition-generation",
      expectedIndexGeneration: 2,
      nextIndexGeneration: 3,
    });
    const generationCommitted = IndexCheckpointSchema.parse({
      ...committedCheckpoint,
      operationId: "operation:pending-transition-generation-committed",
      expectedIndexGeneration: 1,
      nextIndexGeneration: 2,
    });
    const generationDatabase = fakeInspectionDatabase(
      [committedCheckpoint, generationCommitted, generationCheckpoint],
      committedCheckpoint,
      2,
      generationCheckpoint,
    );
    const generationIndex = createSqliteDeletionIndex(generationDatabase, configuration);
    expectStorageError(
      () => generationIndex.markUncertain(committedCheckpoint),
      "stale-authority",
      "Deletion authority is stale.",
    );

    const noPendingDatabase = fakeInspectionDatabase(
      [committedCheckpoint],
      committedCheckpoint,
      1,
      null,
    );
    const noPendingIndex = createSqliteDeletionIndex(noPendingDatabase, configuration);
    expectStorageError(
      () => noPendingIndex.markUncertain(committedCheckpoint),
      "stale-authority",
      "Deletion authority is stale.",
    );

    const completeNoPendingDatabase = fakeInspectionDatabase(
      [committedCheckpoint],
      committedCheckpoint,
      1,
      null,
    );
    const completeNoPendingIndex = createSqliteDeletionIndex(
      completeNoPendingDatabase,
      configuration,
    );
    expectStorageError(
      () => completeNoPendingIndex.markUncertain(committedCheckpoint),
      "stale-authority",
      "Deletion authority is stale.",
    );

    const staleCommitDb = new NodeSqliteTestDatabase();
    initializeDeletionIndex(staleCommitDb, configuration);
    const staleCommitIndex = createSqliteDeletionIndex(staleCommitDb, configuration);
    const staleCommitCheckpoint = await staleCommitIndex.prepare({
      operationId: "operation:stale-prepared-commit",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    staleCommitDb.execute(
      "UPDATE marea_deletion_index_meta SET state = 'uncertain' WHERE singleton = 1",
    );
    expectStorageError(
      () => staleCommitIndex.commit(staleCommitCheckpoint),
      "stale-authority",
      "Deletion authority is stale.",
    );
    staleCommitDb.close();
  });

  it("fails closed when a transaction boundary does not persist its result", async () => {
    const delegate = new NodeSqliteTestDatabase();
    initializeDeletionIndex(delegate, configuration);
    const realIndex = createSqliteDeletionIndex(delegate, configuration);
    const checkpoint = await realIndex.prepare({
      operationId: "operation:no-op-transaction",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const noOp: SqliteApplicationDatabase = {
      execute: delegate.execute.bind(delegate),
      readAll: delegate.readAll.bind(delegate),
      readOne: delegate.readOne.bind(delegate),
      transaction: (() => undefined) as SqliteApplicationDatabase["transaction"],
    };
    const index = createSqliteDeletionIndex(noOp, configuration);
    expectStorageError(
      () => index.commit(checkpoint),
      "invalid-transition",
      "Commit did not persist.",
    );
    expectStorageError(
      () => index.startContent(checkpoint),
      "invalid-transition",
      "Transition did not persist.",
    );
    delegate.close();
  });

  it("fails closed for missing authority and invalid schema during initialization", async () => {
    expect(DELETION_INDEX_SCHEMA).toHaveLength(3);
    expect(DELETION_INDEX_SCHEMA).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE marea_deletion_index_meta"),
        expect.stringContaining("CREATE TABLE marea_deletion_index_tombstones"),
        expect.stringContaining("CREATE TABLE marea_deletion_index_checkpoints"),
      ]),
    );
    expect(DELETION_INDEX_SCHEMA.every((statement) => statement.includes("CREATE TABLE"))).toBe(
      true,
    );
    const spacedSchema = new NodeSqliteTestDatabase();
    for (const statement of DELETION_INDEX_SCHEMA) {
      spacedSchema.execute(statement.replaceAll(" ", "  "));
    }
    spacedSchema.execute(
      "INSERT INTO marea_deletion_index_meta (singleton, authority_lineage, root_id, database_lineage, generation, state, pending_checkpoint_json) VALUES (1, ?1, ?2, ?3, 0, 'active', NULL)",
      [configuration.authorityLineage, configuration.rootId, configuration.databaseLineage],
    );
    expect(() => {
      initializeDeletionIndex(spacedSchema, configuration);
    }).not.toThrow();
    spacedSchema.close();
    const missingAuthorityDatabase: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => undefined,
      readAll: () => [],
      transaction: (operation) => operation(),
    };
    const missingAuthorityIndex = createSqliteDeletionIndex(
      missingAuthorityDatabase,
      configuration,
    );
    expectStorageError(
      () =>
        missingAuthorityIndex.prepare({
          operationId: "operation:missing-authority-exact",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [target],
          artifactDigest: digest,
        }),
      "missing-authority",
      "Deletion authority is missing.",
    );
    await expect(missingAuthorityIndex.assertCreatable(target)).resolves.toEqual({
      allowed: false,
      code: "missing-authority",
    });

    let schemaReads = 0;
    const invalidSchemaDatabase: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => undefined,
      readAll: () => {
        schemaReads += 1;
        return schemaReads === 1 ? [] : [];
      },
      transaction: (operation) => operation(),
    };
    expect(() => {
      initializeDeletionIndex(invalidSchemaDatabase, configuration);
    }).toThrow("schema is invalid");

    const malformedSchemaDatabase: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => undefined,
      readAll: (sql) => (sql.includes("sqlite_schema") ? [{ type: 1, name: "foreign" }] : []),
      transaction: (operation) => operation(),
    };
    expectStorageError(
      () => {
        initializeDeletionIndex(malformedSchemaDatabase, configuration);
      },
      "index-corrupt",
      "Index data is invalid.",
    );
  });

  it("reports missing metadata when schema objects remain without authority", () => {
    const database: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => undefined,
      readAll: (sql) =>
        sql.includes("sqlite_schema") ? [{ name: "marea_deletion_index_checkpoints" }] : [],
      transaction: (operation) => operation(),
    };
    expect(() => readConsistentInspection(database, configuration)).toThrow("metadata is missing");
  });

  it("fails closed when a prepared checkpoint generation changes after inspection", async () => {
    const delegate = new NodeSqliteTestDatabase();
    initializeDeletionIndex(delegate, configuration);
    const index = createSqliteDeletionIndex(delegate, configuration);
    const prepared = await index.prepare({
      operationId: "operation:evidence-generation-race",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const database: SqliteApplicationDatabase = {
      execute: delegate.execute.bind(delegate),
      readAll: delegate.readAll.bind(delegate),
      readOne(sql, parameters = []) {
        if (sql.includes("SELECT operation_id, checkpoint_json")) {
          delegate.execute(
            "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
            [
              JSON.stringify({ ...prepared, expectedIndexGeneration: 1, nextIndexGeneration: 2 }),
              prepared.operationId,
            ],
          );
        }
        return delegate.readOne(sql, parameters);
      },
      transaction: (operation) => {
        return delegate.transaction(operation);
      },
    };
    const evidence = createSqliteAuditIndexEvidence(database, configuration);
    expect(
      evidence.read({
        operationId: prepared.operationId,
        authorityLineage: configuration.authorityLineage,
        artifactDigest: digest,
        expectedIndexGeneration: 1,
      }),
    ).toEqual({ kind: "unavailable" });
    delegate.close();
  });

  it("rejects a tombstone that appears between prepare reads", () => {
    const delegate = new NodeSqliteTestDatabase();
    initializeDeletionIndex(delegate, configuration);
    let keyReads = 0;
    const raced: SqliteApplicationDatabase = {
      execute: delegate.execute.bind(delegate),
      readOne: delegate.readOne.bind(delegate),
      readAll(sql, parameters = []) {
        if (sql.includes("SELECT logical_key FROM marea_deletion_index_tombstones")) {
          keyReads += 1;
          if (keyReads === 2) {
            delegate.execute(
              "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
              [
                configuration.authorityLineage,
                target.kind,
                targetIdentity(target),
                JSON.stringify(target),
                "operation:race-tombstone",
                "2026-09-13T10:00:00.000Z",
              ],
            );
          }
        }
        return delegate.readAll(sql, parameters);
      },
      transaction: (operation) => {
        return delegate.transaction(operation);
      },
    };
    const index = createSqliteDeletionIndex(raced, configuration);
    expect(() =>
      index.prepare({
        operationId: "operation:race-tombstone",
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    ).toThrow("already tombstoned");
    delegate.close();
  });

  it("rejects replay when authority becomes non-active before commit", async () => {
    const delegate = new NodeSqliteTestDatabase();
    initializeDeletionIndex(delegate, configuration);
    const realIndex = createSqliteDeletionIndex(delegate, configuration);
    const committed = await realIndex.commit(
      await realIndex.prepare({
        operationId: "operation:stale-replay",
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    const raced: SqliteApplicationDatabase = {
      execute: delegate.execute.bind(delegate),
      readAll: delegate.readAll.bind(delegate),
      readOne: delegate.readOne.bind(delegate),
      transaction(operation) {
        delegate.execute(
          "UPDATE marea_deletion_index_meta SET state = 'uncertain' WHERE singleton = 1",
        );
        return delegate.transaction(operation);
      },
    };
    const index = createSqliteDeletionIndex(raced, configuration);
    expectStorageError(
      () => index.commit(committed),
      "stale-authority",
      "Deletion authority is stale.",
    );
    delegate.close();
  });

  it("rejects checkpoint rows whose selected identity does not match", () => {
    const checkpoint = preparedCheckpoint("operation:selected-row");
    const database: SqliteApplicationDatabase = {
      execute: () => undefined,
      readAll: () => [],
      readOne: () => ({
        operation_id: "operation:other",
        checkpoint_json: JSON.stringify(checkpoint),
        targets_json: JSON.stringify([target]),
      }),
      transaction: (operation) => operation(),
    };
    expect(readCheckpoint(database, checkpoint.operationId)).toBeUndefined();
  });

  it("rejects a commit when the durable pending marker is absent", () => {
    const checkpoint = preparedCheckpoint("operation:missing-marker");
    const database: SqliteApplicationDatabase = {
      execute: () => undefined,
      readAll: () => [],
      readOne: (sql) =>
        sql.includes("marea_deletion_index_checkpoints")
          ? {
              operation_id: checkpoint.operationId,
              checkpoint_json: JSON.stringify(checkpoint),
              targets_json: JSON.stringify([target]),
            }
          : {
              authority_lineage: configuration.authorityLineage,
              root_id: configuration.rootId,
              database_lineage: configuration.databaseLineage,
              generation: 0,
              state: "active",
              pending_checkpoint_json: null,
            },
      transaction: (operation) => operation(),
    };
    const index = createSqliteDeletionIndex(database, configuration);
    expectStorageError(
      () => index.commit(checkpoint),
      "pending-checkpoint",
      "Deletion index has a pending checkpoint.",
    );
  });

  it("fails closed if the creatability tombstone read is interrupted", async () => {
    const delegate = new NodeSqliteTestDatabase();
    initializeDeletionIndex(delegate, configuration);
    const database: SqliteApplicationDatabase = {
      execute: delegate.execute.bind(delegate),
      readOne: delegate.readOne.bind(delegate),
      readAll(sql, parameters = []) {
        if (sql.includes("SELECT logical_key FROM marea_deletion_index_tombstones"))
          throw new Error("injected tombstone read failure");
        return delegate.readAll(sql, parameters);
      },
      transaction: (operation) => {
        return delegate.transaction(operation);
      },
    };
    const index = createSqliteDeletionIndex(database, configuration);
    await expect(
      index.assertCreatable({ ...target, key: { userId: "user:other" } }),
    ).resolves.toEqual({
      allowed: false,
      code: "corrupt",
    });
    delegate.close();
  });

  it("checks every durable evidence binding and allows explicit uncertain recovery", () => {
    const makeStores = () => {
      const database = schemaEightDatabase();
      activateApplicationAuditSchema(database);
      const value = artifact();
      let evidenceResult: AuditIndexEvidenceResult = {
        kind: "no-intent",
        operationId: value.previewId,
        authorityLineage: value.authorityLineage,
        artifactDigest: value.artifactDigest,
        expectedIndexGeneration: value.expectedIndexGeneration,
      };
      const stores = createApplicationAuditStores(database, { read: () => evidenceResult });
      stores.audit.recordPrepared(value, value.createdAt);
      return {
        database,
        stores,
        value,
        setEvidence: (next: AuditIndexEvidenceResult) => (evidenceResult = next),
      };
    };
    const evidenceBindings: readonly (keyof AuditIndexEvidenceRequest)[] = [
      "operationId",
      "authorityLineage",
      "artifactDigest",
      "expectedIndexGeneration",
    ];
    for (const key of evidenceBindings) {
      const fixture = makeStores();
      fixture.setEvidence(
        mismatchedEvidence(
          {
            kind: "no-intent",
            operationId: fixture.value.previewId,
            authorityLineage: fixture.value.authorityLineage,
            artifactDigest: fixture.value.artifactDigest,
            expectedIndexGeneration: fixture.value.expectedIndexGeneration,
          },
          key,
        ),
      );
      expect(() => {
        fixture.stores.audit.advance({
          operationId: fixture.value.previewId,
          expectedState: "prepared",
          nextState: "failed",
          now: fixture.value.createdAt,
        });
      }).toThrow("no-intent");
      fixture.database.close();
    }

    for (const key of evidenceBindings) {
      const fixture = makeStores();
      fixture.setEvidence(
        mismatchedEvidence(
          {
            kind: "intent",
            operationId: fixture.value.previewId,
            authorityLineage: fixture.value.authorityLineage,
            artifactDigest: fixture.value.artifactDigest,
            expectedIndexGeneration: fixture.value.expectedIndexGeneration,
            nextIndexGeneration: 1,
            state: "committed",
            contentState: "pending",
            durableIntent: "committed",
          },
          key,
        ),
      );
      expect(() => {
        fixture.stores.audit.advance({
          operationId: fixture.value.previewId,
          expectedState: "prepared",
          nextState: "index-committed",
          now: fixture.value.createdAt,
        });
      }).toThrow("durable index intent");
      fixture.database.close();
    }

    const uncertain = makeStores();
    uncertain.setEvidence({ kind: "unavailable" });
    expect(() => {
      uncertain.stores.audit.advance({
        operationId: uncertain.value.previewId,
        expectedState: "prepared",
        nextState: "uncertain",
        now: uncertain.value.createdAt,
      });
    }).not.toThrow();
    uncertain.setEvidence({
      kind: "intent",
      operationId: uncertain.value.previewId,
      authorityLineage: uncertain.value.authorityLineage,
      artifactDigest: uncertain.value.artifactDigest,
      expectedIndexGeneration: 0,
      nextIndexGeneration: 1,
      state: "uncertain",
      contentState: "pending",
      durableIntent: "committed",
    });
    expect(() => {
      uncertain.stores.audit.advance({
        operationId: uncertain.value.previewId,
        expectedState: "uncertain",
        nextState: "index-committed",
        now: uncertain.value.createdAt,
      });
    }).not.toThrow();
    uncertain.database.close();
  });

  it("recovers failed-before-intent checkpoints and preserves exactly-once commit", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const index = createSqliteDeletionIndex(database, config);
    const prepared = await index.prepare({
      operationId: "operation:failed-first",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const failed = await index.failBeforeIntent(prepared);
    expect(failed).toMatchObject({ state: "failed", durableIntent: "none" });
    expect((await index.inspect()).pendingCheckpoint).toBeNull();
    expect((await index.assertCreatable(target)).allowed).toBe(true);
    expect(() => index.failBeforeIntent(prepared)).toThrow("not current");

    const retry = await index.prepare({
      operationId: "operation:failed-retry",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const committed = await index.commit(retry);
    expect(await index.commit(committed)).toEqual(committed);
    expectStorageError(
      () => index.completeContent(committed),
      "invalid-transition",
      "Index checkpoint transition is invalid.",
    );
    const started = await index.startContent(committed);
    expect((await index.completeContent(started)).contentState).toBe("complete");
    database.close();
  });

  it("rejects foreign schemas and non-active authority during initialization", () => {
    const foreign = new NodeSqliteTestDatabase();
    foreign.executeScript("CREATE TABLE unrelated (value TEXT) STRICT");
    expect(() => {
      initializeDeletionIndex(foreign, configuration);
    }).toThrow("schema is foreign");
    foreign.close();

    const database = new NodeSqliteTestDatabase();
    initializeDeletionIndex(database, configuration);
    database.execute("UPDATE marea_deletion_index_meta SET state = 'retired' WHERE singleton = 1");
    expect(() => {
      initializeDeletionIndex(database, configuration);
    }).toThrow("not compatible");
    database.close();

    for (const change of [
      { authorityLineage: AuthorityLineageSchema.parse("lineage:other") },
      { rootId: RootIdSchema.parse("root:other") },
      { databaseLineage: Sha256DigestSchema.parse(`sha256:${"b".repeat(64)}`) },
    ]) {
      const mismatch = new NodeSqliteTestDatabase();
      initializeDeletionIndex(mismatch, configuration);
      expectStorageError(
        () => {
          initializeDeletionIndex(mismatch, { ...configuration, ...change });
        },
        "stale-authority",
        "Deletion authority is not compatible.",
      );
      mismatch.close();
    }
  });

  it("blocks unknown readers and validates restored identity ancestry", async () => {
    const database = new NodeSqliteTestDatabase();
    const config = { ...configuration };
    initializeDeletionIndex(database, config);
    const bundleDigest = ManifestSha256Schema.parse("c".repeat(64));
    const identity = restoredIdentity(config, bundleDigest);
    const noReader = createSqliteDeletionIndex(database, config);
    await expect(noReader.reconcile(identity)).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "unknown-ancestry",
      checked: 0,
    });

    const index = createSqliteDeletionIndex(database, config, { read: () => Promise.resolve([]) });
    await expect(
      index.reconcile({
        ...identity,
        destinationRootId: RootIdSchema.parse("root:other"),
      }),
    ).resolves.toMatchObject({ state: "blocked", reasonCode: "unknown-ancestry" });
    await expect(
      index.reconcile({
        ...identity,
        destinationAuthorityLineage: AuthorityLineageSchema.parse("lineage:other"),
      }),
    ).resolves.toMatchObject({ state: "blocked", reasonCode: "lineage-conflict" });
    await expect(
      index.reconcile({
        ...identity,
        sourceIndexGeneration: 1,
        sourceCheckpointDigest: authorityCheckpointDigest({
          authorityLineage: config.authorityLineage,
          rootId: config.rootId,
          indexGeneration: 1,
          databaseLineage: config.databaseLineage,
          bundleManifestDigest: bundleDigest,
        }),
      }),
    ).resolves.toMatchObject({ state: "blocked", reasonCode: "stale-generation" });
    await expect(index.reconcile(identity)).resolves.toMatchObject({
      state: "verified",
      reasonCode: "none",
      checked: 0,
    });
    database.close();
  });

  it("fails closed for mismatched audit progress and corrupt stored artifacts", () => {
    const database = schemaEightDatabase();
    activateApplicationAuditSchema(database);
    let evidenceResult: AuditIndexEvidenceResult = {
      kind: "intent",
      operationId: "operation:one",
      authorityLineage: configuration.authorityLineage,
      artifactDigest: digest,
      expectedIndexGeneration: 0,
      nextIndexGeneration: 1,
      state: "uncertain",
      contentState: "pending",
      durableIntent: "committed",
    };
    const stores = createApplicationAuditStores(database, { read: () => evidenceResult });
    const value = artifact();
    stores.audit.recordPrepared(value, value.createdAt);
    evidenceResult = {
      ...evidenceResult,
      operationId: value.previewId,
      artifactDigest: value.artifactDigest,
    };
    expect(() => {
      stores.audit.advance({
        operationId: value.previewId,
        expectedState: "prepared",
        nextState: "index-committed",
        now: value.createdAt,
      });
    }).toThrow("Uncertain index evidence");
    evidenceResult = { ...evidenceResult, state: "committed", contentState: "complete" };
    expect(() => {
      stores.audit.advance({
        operationId: value.previewId,
        expectedState: "prepared",
        nextState: "index-committed",
        now: value.createdAt,
      });
    }).toThrow("content state");
    expect(() => {
      stores.audit.advance({
        operationId: value.previewId,
        expectedState: "applied",
        nextState: "failed",
        now: value.createdAt,
      });
    }).toThrow("expected state");
    database.execute(
      "UPDATE marea_retention_operations SET artifact_json = '{}' WHERE operation_id = ?1",
      [value.previewId],
    );
    expect(() => {
      stores.dispositions.record(value.previewId, {
        target,
        disposition: "deleted",
        updatedAt: value.createdAt,
      });
    }).toThrow("artifact is malformed");
    database.close();
  });

  it("rejects storage paths whose existing parent cannot be physically verified", () => {
    const root = mkdtempSync(join(tmpdir(), "marea-operations-path-parent-"));
    const fileParent = join(root, "file-parent");
    writeFileSync(fileParent, "not-a-directory");
    const config = parseStorageConfiguration({
      ...configuration,
      installationRoot: root,
      databasePath: join(fileParent, "application.sqlite"),
      indexPath: join(fileParent, "deletion-index.sqlite"),
    });
    expect(() => {
      initializeDeletionIndex(new NodeSqliteTestDatabase(), config);
    }).toThrow("parent cannot be physically verified");
    rmSync(root, { recursive: true, force: true });
  });

  it("parses inspection metadata and rejects malformed pending markers", () => {
    const expected = {
      authorityLineage: configuration.authorityLineage,
      rootId: configuration.rootId,
      databaseLineage: configuration.databaseLineage,
    };
    expect(inspectFromRow(undefined, expected).state).toBe("missing");
    expect(
      inspectFromRow(
        {
          authority_lineage: expected.authorityLineage,
          root_id: expected.rootId,
          database_lineage: expected.databaseLineage,
          generation: 0n,
          state: "active",
          pending_checkpoint_json: null,
        },
        expected,
      ),
    ).toMatchObject({ state: "active", generation: 0 });
    expectStorageError(
      () =>
        inspectFromRow(
          {
            authority_lineage: expected.authorityLineage,
            root_id: expected.rootId,
            database_lineage: expected.databaseLineage,
            generation: 0,
            state: "active",
            pending_checkpoint_json: "{",
          },
          expected,
        ),
      "index-corrupt",
      "Pending checkpoint is invalid.",
    );
    expectStorageError(
      () =>
        inspectFromRow(
          {
            authority_lineage: 1,
            root_id: expected.rootId,
            database_lineage: expected.databaseLineage,
            generation: 0,
            state: "active",
            pending_checkpoint_json: null,
          },
          expected,
        ),
      "index-corrupt",
      "Index metadata is invalid.",
    );
    expect(
      IndexCheckpointSchema.parse({
        operationId: "operation:inspection",
        authorityLineage: expected.authorityLineage,
        expectedIndexGeneration: 0,
        nextIndexGeneration: 1,
        targetCount: 1,
        artifactDigest: digest,
        state: "prepared",
      }).state,
    ).toBe("prepared");
    expectStorageError(
      () =>
        inspectFromRow(
          {
            authority_lineage: expected.authorityLineage,
            root_id: expected.rootId,
            database_lineage: expected.databaseLineage,
            generation: Number.MAX_SAFE_INTEGER + 1,
            state: "active",
            pending_checkpoint_json: null,
          },
          expected,
        ),
      "index-corrupt",
      "Index metadata is invalid.",
    );
    expectStorageError(
      () =>
        inspectFromRow(
          {
            authority_lineage: expected.authorityLineage,
            root_id: expected.rootId,
            database_lineage: expected.databaseLineage,
            generation: 0,
            state: "active",
            pending_checkpoint_json: "null",
          },
          expected,
        ),
      "index-corrupt",
      "Pending checkpoint is invalid.",
    );
  });

  it("rejects invalid metadata scalar types and malformed selected rows", () => {
    const metadata = {
      authority_lineage: configuration.authorityLineage,
      root_id: configuration.rootId,
      database_lineage: configuration.databaseLineage,
      generation: 0,
      state: "active",
      pending_checkpoint_json: null,
    };
    expectStorageError(
      () => inspectFromRow({ ...metadata, pending_checkpoint_json: 7 }, configuration),
      "index-corrupt",
      "Index data is invalid.",
    );
    expectStorageError(
      () => inspectFromRow({ ...metadata, generation: "0" }, configuration),
      "index-corrupt",
      "Index metadata is invalid.",
    );
    expectStorageError(
      () => inspectFromRow({ ...metadata, generation: Number.MAX_SAFE_INTEGER + 1 }, configuration),
      "index-corrupt",
      "Index metadata is invalid.",
    );
    const { pending_checkpoint_json: pendingCheckpointJson, ...metadataWithoutPendingCheckpoint } =
      metadata;
    expect(pendingCheckpointJson).toBeNull();
    expect(inspectFromRow(metadataWithoutPendingCheckpoint, configuration)).toMatchObject({
      state: "active",
      pendingCheckpoint: null,
    });
    const malformedRowDatabase: SqliteApplicationDatabase = {
      execute: () => undefined,
      readAll: () => [],
      readOne: () => ({
        operation_id: "operation:selected",
        checkpoint_json: "[]",
        targets_json: "[]",
      }),
      transaction: (operation) => operation(),
    };
    expectStorageError(
      () => readCheckpoint(malformedRowDatabase, "operation:selected"),
      "index-corrupt",
      "Checkpoint data is invalid.",
    );
  });

  it("fails closed for corrupt checkpoint and tombstone catalogs", async () => {
    const createIndexFixture = () => {
      const database = new NodeSqliteTestDatabase();
      const config = { ...configuration };
      initializeDeletionIndex(database, config);
      return { database, config, index: createSqliteDeletionIndex(database, config) };
    };
    const corruptCheckpoint = createIndexFixture();
    await corruptCheckpoint.index.prepare({
      operationId: "operation:bad-checkpoint",
      authorityLineage: corruptCheckpoint.config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    corruptCheckpoint.database.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1",
      ["{}"],
    );
    expect((await corruptCheckpoint.index.inspect()).state).toBe("corrupt");
    corruptCheckpoint.database.close();

    const corruptTargets = createIndexFixture();
    await corruptTargets.index.prepare({
      operationId: "operation:bad-targets",
      authorityLineage: corruptTargets.config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    corruptTargets.database.execute(
      "UPDATE marea_deletion_index_checkpoints SET targets_json = ?1",
      ["{}"],
    );
    expect((await corruptTargets.index.inspect()).state).toBe("corrupt");
    corruptTargets.database.close();

    const duplicateTargets = createIndexFixture();
    const duplicate = await duplicateTargets.index.prepare({
      operationId: "operation:duplicate-targets",
      authorityLineage: duplicateTargets.config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    duplicateTargets.database.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1, targets_json = ?2",
      [JSON.stringify({ ...duplicate, targetCount: 2 }), JSON.stringify([target, target])],
    );
    expect((await duplicateTargets.index.inspect()).state).toBe("corrupt");
    duplicateTargets.database.close();

    const invalidUncertain = createIndexFixture();
    const uncertain = await invalidUncertain.index.prepare({
      operationId: "operation:invalid-uncertain",
      authorityLineage: invalidUncertain.config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    invalidUncertain.database.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1",
      [
        JSON.stringify({
          ...uncertain,
          state: "uncertain",
          contentState: "in-progress",
        }),
      ],
    );
    expect((await invalidUncertain.index.inspect()).state).toBe("corrupt");
    invalidUncertain.database.close();

    const preparedTombstone = createIndexFixture();
    const prepared = await preparedTombstone.index.prepare({
      operationId: "operation:prepared-tombstone",
      authorityLineage: preparedTombstone.config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    preparedTombstone.database.execute(
      "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [
        preparedTombstone.config.authorityLineage,
        target.kind,
        targetIdentity(target),
        JSON.stringify(target),
        prepared.operationId,
        "2026-09-13T10:00:00.000Z",
      ],
    );
    expect((await preparedTombstone.index.inspect()).state).toBe("corrupt");
    preparedTombstone.database.close();

    const duplicatePending = createIndexFixture();
    const first = await duplicatePending.index.prepare({
      operationId: "operation:first-pending",
      authorityLineage: duplicatePending.config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const second = { ...first, operationId: "operation:second-pending" };
    duplicatePending.database.execute(
      "INSERT INTO marea_deletion_index_checkpoints (operation_id, checkpoint_json, targets_json) VALUES (?1, ?2, ?3)",
      [second.operationId, JSON.stringify(second), JSON.stringify([target])],
    );
    expect((await duplicatePending.index.inspect()).state).toBe("corrupt");
    expectStorageError(
      () => readConsistentInspection(duplicatePending.database, duplicatePending.config),
      "index-corrupt",
      "Multiple pending checkpoints exist.",
    );
    duplicatePending.database.close();

    const orphanTombstone = createIndexFixture();
    orphanTombstone.database.execute(
      "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [
        orphanTombstone.config.authorityLineage,
        target.kind,
        targetIdentity(target),
        JSON.stringify(target),
        "operation:missing",
        "2026-09-13T10:00:00.000Z",
      ],
    );
    expect((await orphanTombstone.index.inspect()).state).toBe("corrupt");
    orphanTombstone.database.close();

    const mismatchedTombstone = createIndexFixture();
    const committed = await mismatchedTombstone.index.commit(
      await mismatchedTombstone.index.prepare({
        operationId: "operation:mismatched-tombstone",
        authorityLineage: mismatchedTombstone.config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    mismatchedTombstone.database.execute(
      "UPDATE marea_deletion_index_tombstones SET target_kind = 'class' WHERE operation_id = ?1",
      [committed.operationId],
    );
    expect((await mismatchedTombstone.index.inspect()).state).toBe("corrupt");
    mismatchedTombstone.database.close();

    const incompleteTombstone = createIndexFixture();
    const completed = await incompleteTombstone.index.commit(
      await incompleteTombstone.index.prepare({
        operationId: "operation:incomplete-tombstone",
        authorityLineage: incompleteTombstone.config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    incompleteTombstone.database.execute(
      "DELETE FROM marea_deletion_index_tombstones WHERE operation_id = ?1",
      [completed.operationId],
    );
    expect((await incompleteTombstone.index.inspect()).state).toBe("corrupt");
    incompleteTombstone.database.close();

    const regressedChain = createIndexFixture();
    await regressedChain.index.commit(
      await regressedChain.index.prepare({
        operationId: "operation:regressed-chain",
        authorityLineage: regressedChain.config.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    regressedChain.database.execute(
      "UPDATE marea_deletion_index_meta SET generation = 2 WHERE singleton = 1",
    );
    expect((await regressedChain.index.inspect()).state).toBe("corrupt");
    regressedChain.database.close();
  });

  it("proves the valid recovery states and exact generation invariants", async () => {
    const uncertainDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(uncertainDatabase, configuration);
    const uncertainIndex = createSqliteDeletionIndex(uncertainDatabase, configuration);
    const prepared = await uncertainIndex.prepare({
      operationId: "operation:valid-uncertain",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const uncertain = IndexCheckpointSchema.parse({
      ...prepared,
      state: "uncertain",
      contentState: "pending",
      durableIntent: "none",
    });
    uncertainDatabase.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [JSON.stringify(uncertain), prepared.operationId],
    );
    uncertainDatabase.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify(uncertain)],
    );
    expect(readConsistentInspection(uncertainDatabase, configuration)).toMatchObject({
      state: "active",
      generation: 0,
      pendingCheckpoint: uncertain,
    });
    uncertainDatabase.close();

    const targetCountDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(targetCountDatabase, configuration);
    const targetCountIndex = createSqliteDeletionIndex(targetCountDatabase, configuration);
    const targetCountCheckpoint = await targetCountIndex.prepare({
      operationId: "operation:target-count",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    targetCountDatabase.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [
        JSON.stringify({ ...targetCountCheckpoint, targetCount: 2 }),
        targetCountCheckpoint.operationId,
      ],
    );
    expectStorageError(
      () => readConsistentInspection(targetCountDatabase, configuration),
      "index-corrupt",
      "Checkpoint data is inconsistent.",
    );
    targetCountDatabase.close();

    const generationDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(generationDatabase, configuration);
    const generationIndex = createSqliteDeletionIndex(generationDatabase, configuration);
    const committed = await generationIndex.commit(
      await generationIndex.prepare({
        operationId: "operation:authority-generation",
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    generationDatabase.execute(
      "UPDATE marea_deletion_index_meta SET generation = ?1 WHERE singleton = 1",
      [committed.nextIndexGeneration + 1],
    );
    expectStorageError(
      () => readConsistentInspection(generationDatabase, configuration),
      "index-corrupt",
      "Authority generation is inconsistent.",
    );
    generationDatabase.close();

    const failedDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(failedDatabase, configuration);
    const failedIndex = createSqliteDeletionIndex(failedDatabase, configuration);
    const failedPrepared = await failedIndex.prepare({
      operationId: "operation:failed-generation-exact",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const failed = await failedIndex.failBeforeIntent(failedPrepared);
    failedDatabase.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [
        JSON.stringify({ ...failed, expectedIndexGeneration: 1, nextIndexGeneration: 2 }),
        failed.operationId,
      ],
    );
    expectStorageError(
      () => readConsistentInspection(failedDatabase, configuration),
      "index-corrupt",
      "Checkpoint generation is stale.",
    );
    failedDatabase.close();
  });

  it("asserts exact tombstone catalog bindings and payload preservation", async () => {
    const targetTwo: TargetRef = {
      kind: "account",
      key: { userId: "user:two" },
      observed: { kind: "version", version: "v1" },
    };
    const targetThree: TargetRef = {
      kind: "account",
      key: { userId: "user:three" },
      observed: { kind: "version", version: "v1" },
    };
    const makeCommitted = async (operationId: string, targets: readonly TargetRef[] = [target]) => {
      const database = new NodeSqliteTestDatabase();
      initializeDeletionIndex(database, configuration);
      const index = createSqliteDeletionIndex(database, configuration);
      const checkpoint = await index.commit(
        await index.prepare({
          operationId,
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 0,
          targets,
          artifactDigest: digest,
        }),
      );
      return { database, checkpoint, index };
    };

    const prepared = new NodeSqliteTestDatabase();
    initializeDeletionIndex(prepared, configuration);
    const preparedIndex = createSqliteDeletionIndex(prepared, configuration);
    const pending = await preparedIndex.prepare({
      operationId: "operation:prepared-tombstone-exact",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    prepared.execute(
      "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [
        configuration.authorityLineage,
        target.kind,
        targetIdentity(target),
        JSON.stringify(target),
        pending.operationId,
        "2026-09-13T10:00:00.000Z",
      ],
    );
    expectStorageError(
      () => readConsistentInspection(prepared, configuration),
      "index-corrupt",
      "Prepared checkpoint has tombstones.",
    );
    prepared.close();

    const orphan = await makeCommitted("operation:orphan-exact");
    orphan.database.execute(
      "UPDATE marea_deletion_index_tombstones SET operation_id = ?1 WHERE operation_id = ?2",
      ["operation:missing", orphan.checkpoint.operationId],
    );
    expectStorageError(
      () => readConsistentInspection(orphan.database, configuration),
      "index-corrupt",
      "Tombstone has no matching checkpoint.",
    );
    orphan.database.close();

    const foreign = await makeCommitted("operation:foreign-exact");
    foreign.database.execute(
      "UPDATE marea_deletion_index_tombstones SET authority_lineage = ?1 WHERE operation_id = ?2",
      ["lineage:foreign", foreign.checkpoint.operationId],
    );
    expectStorageError(
      () => readConsistentInspection(foreign.database, configuration),
      "index-corrupt",
      "Tombstone has no matching checkpoint.",
    );
    foreign.database.close();

    const mismatched = await makeCommitted("operation:identity-exact");
    mismatched.database.execute(
      "UPDATE marea_deletion_index_tombstones SET target_kind = ?1 WHERE operation_id = ?2",
      ["class", mismatched.checkpoint.operationId],
    );
    expectStorageError(
      () => readConsistentInspection(mismatched.database, configuration),
      "index-corrupt",
      "Tombstone identity is inconsistent.",
    );
    mismatched.database.close();

    const extra = await makeCommitted("operation:extra-exact", [target, targetTwo]);
    expect(readConsistentInspection(extra.database, configuration)).toMatchObject({
      state: "active",
      generation: 1,
    });
    extra.database.execute(
      "UPDATE marea_deletion_index_tombstones SET logical_key = ?1, target_json = ?2 WHERE logical_key = ?3",
      [targetIdentity(targetThree), JSON.stringify(targetThree), targetIdentity(target)],
    );
    expectStorageError(
      () => readConsistentInspection(extra.database, configuration),
      "index-corrupt",
      "Committed tombstones are incomplete.",
    );
    extra.database.close();

    const extraTombstone = await makeCommitted("operation:extra-tombstone-exact");
    extraTombstone.database.execute(
      "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [
        configuration.authorityLineage,
        targetTwo.kind,
        targetIdentity(targetTwo),
        JSON.stringify(targetTwo),
        extraTombstone.checkpoint.operationId,
        "2026-09-13T10:00:00.000Z",
      ],
    );
    expectStorageError(
      () => readConsistentInspection(extraTombstone.database, configuration),
      "index-corrupt",
      "Committed tombstones are incomplete.",
    );
    extraTombstone.database.close();

    const payload = await makeCommitted("operation:payload-exact");
    expect(readConsistentInspection(payload.database, configuration)).toMatchObject({
      state: "active",
      generation: 1,
    });
    payload.database.execute(
      "UPDATE marea_deletion_index_tombstones SET target_json = ?1 WHERE operation_id = ?2",
      [
        JSON.stringify({ ...target, observed: { kind: "version", version: "v2" } }),
        payload.checkpoint.operationId,
      ],
    );
    expectStorageError(
      () => readConsistentInspection(payload.database, configuration),
      "index-corrupt",
      "Committed tombstone payload differs.",
    );
    payload.database.close();
  });

  it("keeps exact blocked reconciliation output and schema normalization", async () => {
    expect(normalizeSql("  CREATE   TABLE IF NOT EXISTS sample ( value TEXT )  ")).toBe(
      "CREATE TABLE sample ( value TEXT )",
    );
    const database = new NodeSqliteTestDatabase();
    initializeDeletionIndex(database, configuration);
    const identity = restoredIdentity(configuration, ManifestSha256Schema.parse("d".repeat(64)));
    const index = createSqliteDeletionIndex(database, configuration);
    await expect(index.reconcile(identity)).resolves.toEqual({
      state: "blocked",
      currentIndexGeneration: 0,
      checked: 0,
      tombstoned: [],
      reasonCode: "unknown-ancestry",
    });
    database.close();

    const spaced = new NodeSqliteTestDatabase();
    for (const statement of DELETION_INDEX_SCHEMA) spaced.execute(statement.replaceAll(" ", "  "));
    spaced.execute(
      "INSERT INTO marea_deletion_index_meta (singleton, authority_lineage, root_id, database_lineage, generation, state, pending_checkpoint_json) VALUES (1, ?1, ?2, ?3, 0, 'active', NULL)",
      [configuration.authorityLineage, configuration.rootId, configuration.databaseLineage],
    );
    expect(() => {
      initializeDeletionIndex(spaced, configuration);
    }).not.toThrow();
    spaced.close();

    const normalizedRows = DELETION_INDEX_SCHEMA.map((statement) => {
      const match = /CREATE TABLE ([^ (]+)/u.exec(statement);
      if (match === null) throw new Error("Expected a table schema.");
      const tableName = match[1];
      if (tableName === undefined) throw new Error("Expected a table name.");
      return {
        type: "table",
        name: tableName,
        tbl_name: tableName,
        sql: statement.replaceAll(" ", "  "),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const normalizedSchema: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => ({
        authority_lineage: configuration.authorityLineage,
        root_id: configuration.rootId,
        database_lineage: configuration.databaseLineage,
        generation: 0,
        state: "active",
        pending_checkpoint_json: null,
      }),
      readAll: (sql) => (sql.includes("sqlite_schema") ? normalizedRows : []),
      transaction: (operation) => operation(),
    };
    expect(() => {
      initializeDeletionIndex(normalizedSchema, configuration);
    }).not.toThrow();
  });

  it("asserts exact corruption contracts and duplicate checkpoint guards", async () => {
    expect(() => {
      StorageConfigurationSchema.parse({ ...configuration, unexpected: true });
    }).toThrow();
    expect(() => {
      StorageConfigurationSchema.parse({ ...configuration, databasePath: "relative.sqlite" });
    }).toThrow("path must be an absolute persistent path");
    const invalidPath = StorageConfigurationSchema.safeParse({
      ...configuration,
      databasePath: "relative.sqlite",
    });
    expect(invalidPath.success).toBe(false);
    if (!invalidPath.success)
      expect(invalidPath.error.issues).toContainEqual({
        code: "custom",
        path: ["databasePath"],
        message: "path must be an absolute persistent path",
      });

    const duplicateRows = new NodeSqliteTestDatabase();
    initializeDeletionIndex(duplicateRows, configuration);
    const duplicateCheckpoint = await createSqliteDeletionIndex(
      duplicateRows,
      configuration,
    ).prepare({
      operationId: "operation:duplicate-row",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const duplicateRowDatabase: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: (sql) =>
        sql.includes("marea_deletion_index_meta")
          ? {
              authority_lineage: configuration.authorityLineage,
              root_id: configuration.rootId,
              database_lineage: configuration.databaseLineage,
              generation: 0,
              state: "active",
              pending_checkpoint_json: JSON.stringify(duplicateCheckpoint),
            }
          : undefined,
      readAll: (sql) => {
        if (sql.includes("marea_deletion_index_checkpoints"))
          return [
            {
              operation_id: duplicateCheckpoint.operationId,
              checkpoint_json: JSON.stringify(duplicateCheckpoint),
              targets_json: JSON.stringify([target]),
            },
            {
              operation_id: duplicateCheckpoint.operationId,
              checkpoint_json: JSON.stringify(duplicateCheckpoint),
              targets_json: JSON.stringify([target]),
            },
          ];
        return [];
      },
      transaction: (operation) => operation(),
    };
    expectStorageError(
      () => readConsistentInspection(duplicateRowDatabase, configuration),
      "index-corrupt",
      "Checkpoint data is inconsistent.",
    );
    duplicateRows.close();

    const targetDataDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(targetDataDatabase, configuration);
    const targetDataIndex = createSqliteDeletionIndex(targetDataDatabase, configuration);
    const targetDataCheckpoint = await targetDataIndex.prepare({
      operationId: "operation:target-data-exact",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    targetDataDatabase.execute(
      "UPDATE marea_deletion_index_checkpoints SET targets_json = ?1 WHERE operation_id = ?2",
      ["{}", targetDataCheckpoint.operationId],
    );
    expectStorageError(
      () => readConsistentInspection(targetDataDatabase, configuration),
      "index-corrupt",
      "Target data is invalid.",
    );
    targetDataDatabase.close();

    const duplicateTargets = new NodeSqliteTestDatabase();
    initializeDeletionIndex(duplicateTargets, configuration);
    const duplicateTargetIndex = createSqliteDeletionIndex(duplicateTargets, configuration);
    const duplicateTargetCheckpoint = await duplicateTargetIndex.prepare({
      operationId: "operation:duplicate-target-exact",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    duplicateTargets.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1, targets_json = ?2 WHERE operation_id = ?3",
      [
        JSON.stringify({ ...duplicateTargetCheckpoint, targetCount: 2 }),
        JSON.stringify([target, target]),
        duplicateTargetCheckpoint.operationId,
      ],
    );
    expectStorageError(
      () => readConsistentInspection(duplicateTargets, configuration),
      "index-corrupt",
      "Checkpoint data is inconsistent.",
    );
    duplicateTargets.close();

    const invalidUncertain = new NodeSqliteTestDatabase();
    initializeDeletionIndex(invalidUncertain, configuration);
    const invalidUncertainIndex = createSqliteDeletionIndex(invalidUncertain, configuration);
    const invalidPrepared = await invalidUncertainIndex.prepare({
      operationId: "operation:invalid-uncertain-exact",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const invalid = {
      ...invalidPrepared,
      state: "uncertain" as const,
      contentState: "complete" as const,
      durableIntent: "none" as const,
    };
    invalidUncertain.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [JSON.stringify(invalid), invalid.operationId],
    );
    invalidUncertain.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify(invalid)],
    );
    expectStorageError(
      () => readConsistentInspection(invalidUncertain, configuration),
      "index-corrupt",
      "Checkpoint state is inconsistent.",
    );
    invalidUncertain.close();

    const stalePreparedDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(stalePreparedDatabase, configuration);
    const stalePreparedIndex = createSqliteDeletionIndex(stalePreparedDatabase, configuration);
    const stalePrepared = await stalePreparedIndex.prepare({
      operationId: "operation:prepared-generation-exact",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    const stalePreparedValue = {
      ...stalePrepared,
      expectedIndexGeneration: 1,
      nextIndexGeneration: 2,
    };
    stalePreparedDatabase.execute(
      "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
      [JSON.stringify(stalePreparedValue), stalePrepared.operationId],
    );
    stalePreparedDatabase.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify(stalePreparedValue)],
    );
    expectStorageError(
      () => readConsistentInspection(stalePreparedDatabase, configuration),
      "index-corrupt",
      "Checkpoint generation is stale.",
    );
    stalePreparedDatabase.close();

    const logicalMismatch = new NodeSqliteTestDatabase();
    initializeDeletionIndex(logicalMismatch, configuration);
    const logicalIndex = createSqliteDeletionIndex(logicalMismatch, configuration);
    const logicalCommitted = await logicalIndex.commit(
      await logicalIndex.prepare({
        operationId: "operation:logical-mismatch-exact",
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    logicalMismatch.execute(
      "UPDATE marea_deletion_index_tombstones SET logical_key = ?1 WHERE operation_id = ?2",
      ["account:user:other", logicalCommitted.operationId],
    );
    expectStorageError(
      () => readConsistentInspection(logicalMismatch, configuration),
      "index-corrupt",
      "Tombstone identity is inconsistent.",
    );
    logicalMismatch.close();

    const missingObjects: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => undefined,
      readAll: (sql) => (sql.includes("sqlite_schema") ? [{ name: "foreign" }] : []),
      transaction: (operation) => operation(),
    };
    expectStorageError(
      () => readConsistentInspection(missingObjects, configuration),
      "index-corrupt",
      "Deletion authority metadata is missing.",
    );

    const authorityMismatch = new NodeSqliteTestDatabase();
    initializeDeletionIndex(authorityMismatch, configuration);
    authorityMismatch.execute(
      "UPDATE marea_deletion_index_meta SET authority_lineage = ?1 WHERE singleton = 1",
      ["lineage:foreign"],
    );
    expectStorageError(
      () => readConsistentInspection(authorityMismatch, configuration),
      "stale-authority",
      "Configured authority does not match index.",
    );
    authorityMismatch.close();

    const databaseMismatch = new NodeSqliteTestDatabase();
    initializeDeletionIndex(databaseMismatch, configuration);
    databaseMismatch.execute(
      "UPDATE marea_deletion_index_meta SET database_lineage = ?1 WHERE singleton = 1",
      ["sha256:" + "b".repeat(64)],
    );
    expectStorageError(
      () => readConsistentInspection(databaseMismatch, configuration),
      "stale-authority",
      "Configured authority does not match index.",
    );
    databaseMismatch.close();

    const orphanMarker = new NodeSqliteTestDatabase();
    initializeDeletionIndex(orphanMarker, configuration);
    orphanMarker.execute(
      "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
      [JSON.stringify(preparedCheckpoint("operation:orphan-exact"))],
    );
    expectStorageError(
      () => readConsistentInspection(orphanMarker, configuration),
      "index-corrupt",
      "Pending checkpoint marker is orphaned.",
    );
    orphanMarker.close();
  });

  it("exercises the first and second duplicate-target guards independently", async () => {
    const targetTwo: TargetRef = {
      kind: "account",
      key: { userId: "user:second-guard" },
      observed: { kind: "version", version: "v1" },
    };
    const firstGuardDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(firstGuardDatabase, configuration);
    const firstGuardReal = createSqliteDeletionIndex(firstGuardDatabase, configuration);
    const committed = await firstGuardReal.commit(
      await firstGuardReal.prepare({
        operationId: "operation:first-guard-seed",
        authorityLineage: configuration.authorityLineage,
        expectedIndexGeneration: 0,
        targets: [target],
        artifactDigest: digest,
      }),
    );
    await firstGuardReal.completeContent(await firstGuardReal.startContent(committed));
    const noOpTransaction: SqliteApplicationDatabase = {
      execute: firstGuardDatabase.execute.bind(firstGuardDatabase),
      readAll: firstGuardDatabase.readAll.bind(firstGuardDatabase),
      readOne: firstGuardDatabase.readOne.bind(firstGuardDatabase),
      transaction: (() => undefined) as SqliteApplicationDatabase["transaction"],
    };
    const firstGuard = createSqliteDeletionIndex(noOpTransaction, configuration);
    expectStorageError(
      () =>
        firstGuard.prepare({
          operationId: "operation:first-guard-hit",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 1,
          targets: [target, targetTwo],
          artifactDigest: digest,
        }),
      "tombstoned-identity",
      "Deletion target identity is already tombstoned.",
    );
    firstGuardDatabase.close();

    const secondGuardDatabase = new NodeSqliteTestDatabase();
    initializeDeletionIndex(secondGuardDatabase, configuration);
    let tombstoneReads = 0;
    const raced: SqliteApplicationDatabase = {
      execute: secondGuardDatabase.execute.bind(secondGuardDatabase),
      readOne: secondGuardDatabase.readOne.bind(secondGuardDatabase),
      readAll(sql, parameters = []) {
        if (sql.includes("SELECT logical_key FROM marea_deletion_index_tombstones")) {
          tombstoneReads += 1;
          if (tombstoneReads === 2)
            secondGuardDatabase.execute(
              "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
              [
                configuration.authorityLineage,
                target.kind,
                targetIdentity(target),
                JSON.stringify(target),
                "operation:second-guard-race",
                "2026-09-13T10:00:00.000Z",
              ],
            );
        }
        return secondGuardDatabase.readAll(sql, parameters);
      },
      transaction: (operation) => secondGuardDatabase.transaction(operation),
    };
    const secondGuard = createSqliteDeletionIndex(raced, configuration);
    expectStorageError(
      () =>
        secondGuard.prepare({
          operationId: "operation:second-guard-hit",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [target, targetTwo],
          artifactDigest: digest,
        }),
      "tombstoned-identity",
      "Deletion target identity is already tombstoned.",
    );
    secondGuardDatabase.close();
  });

  it("requires every initialization and transition guard to persist", async () => {
    const invalidSchema: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => undefined,
      readAll: () => [],
      transaction: (operation) => operation(),
    };
    expectStorageError(
      () => {
        initializeDeletionIndex(invalidSchema, configuration);
      },
      "index-corrupt",
      "Deletion index schema is invalid.",
    );

    const foreignSchema: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => undefined,
      readAll: (sql) =>
        sql.includes("sqlite_schema")
          ? [
              {
                type: "table",
                name: "foreign",
                tbl_name: "foreign",
                sql: "CREATE TABLE foreign (value TEXT) STRICT",
              },
            ]
          : [],
      transaction: (operation) => operation(),
    };
    expectStorageError(
      () => {
        initializeDeletionIndex(foreignSchema, configuration);
      },
      "index-corrupt",
      "Deletion index schema is foreign.",
    );

    const malformedInitialization = new NodeSqliteTestDatabase();
    initializeDeletionIndex(malformedInitialization, configuration);
    malformedInitialization.execute(
      "INSERT INTO marea_deletion_index_checkpoints (operation_id, checkpoint_json, targets_json) VALUES (?1, ?2, ?3)",
      [
        "operation:malformed-initialize",
        JSON.stringify(preparedCheckpoint("operation:malformed-initialize")),
        "{}",
      ],
    );
    expectStorageError(
      () => {
        initializeDeletionIndex(malformedInitialization, configuration);
      },
      "index-corrupt",
      "Target data is invalid.",
    );
    malformedInitialization.close();

    const corruptCreatability: SqliteApplicationDatabase = {
      execute: () => undefined,
      readOne: () => undefined,
      readAll: (sql) => (sql.includes("sqlite_schema") ? [{ name: "foreign" }] : []),
      transaction: (operation) => operation(),
    };
    await expect(
      createSqliteDeletionIndex(corruptCreatability, configuration).assertCreatable(target),
    ).resolves.toEqual({ allowed: false, code: "corrupt" });

    const missingAuthority = new NodeSqliteTestDatabase();
    initializeDeletionIndex(missingAuthority, configuration);
    missingAuthority.execute("DELETE FROM marea_deletion_index_meta");
    expectStorageError(
      () => {
        initializeDeletionIndex(missingAuthority, configuration);
      },
      "missing-authority",
      "Existing deletion index has no durable authority.",
    );
    missingAuthority.close();

    const inactive = new NodeSqliteTestDatabase();
    initializeDeletionIndex(inactive, configuration);
    inactive.execute("UPDATE marea_deletion_index_meta SET state = 'retired' WHERE singleton = 1");
    expectStorageError(
      () => {
        initializeDeletionIndex(inactive, configuration);
      },
      "stale-authority",
      "Deletion authority is not compatible.",
    );
    inactive.close();

    const inactivePrepare = new NodeSqliteTestDatabase();
    initializeDeletionIndex(inactivePrepare, configuration);
    inactivePrepare.execute(
      "UPDATE marea_deletion_index_meta SET state = 'uncertain' WHERE singleton = 1",
    );
    const inactivePrepareNoOp: SqliteApplicationDatabase = {
      execute: inactivePrepare.execute.bind(inactivePrepare),
      readAll: inactivePrepare.readAll.bind(inactivePrepare),
      readOne: inactivePrepare.readOne.bind(inactivePrepare),
      transaction: (() => undefined) as SqliteApplicationDatabase["transaction"],
    };
    const inactivePrepareIndex = createSqliteDeletionIndex(inactivePrepareNoOp, configuration);
    expectStorageError(
      () =>
        inactivePrepareIndex.prepare({
          operationId: "operation:inactive-prepare",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [target],
          artifactDigest: digest,
        }),
      "stale-authority",
      "Deletion authority is stale.",
    );
    inactivePrepare.close();

    const staleGenerationPrepare = new NodeSqliteTestDatabase();
    initializeDeletionIndex(staleGenerationPrepare, configuration);
    const staleGenerationPrepareIndex = createSqliteDeletionIndex(
      staleGenerationPrepare,
      configuration,
    );
    expectStorageError(
      () =>
        staleGenerationPrepareIndex.prepare({
          operationId: "operation:generation-prepare",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 1,
          targets: [target],
          artifactDigest: digest,
        }),
      "stale-authority",
      "Deletion authority is stale.",
    );
    staleGenerationPrepare.close();

    const pending = new NodeSqliteTestDatabase();
    initializeDeletionIndex(pending, configuration);
    const pendingIndex = createSqliteDeletionIndex(pending, configuration);
    await pendingIndex.prepare({
      operationId: "operation:prepare-guard-exact",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    expectStorageError(
      () =>
        pendingIndex.prepare({
          operationId: "operation:prepare-guard-second",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [{ ...target, key: { userId: "user:prepare-second" } }],
          artifactDigest: digest,
        }),
      "pending-checkpoint",
      "Deletion index has a pending checkpoint.",
    );
    pending.close();

    const transitionRace = new NodeSqliteTestDatabase();
    initializeDeletionIndex(transitionRace, configuration);
    const transitionRaceDatabase: SqliteApplicationDatabase = {
      execute: transitionRace.execute.bind(transitionRace),
      readAll: transitionRace.readAll.bind(transitionRace),
      readOne: transitionRace.readOne.bind(transitionRace),
      transaction(operation) {
        transitionRace.execute(
          "UPDATE marea_deletion_index_meta SET state = 'uncertain' WHERE singleton = 1",
        );
        return transitionRace.transaction(operation);
      },
    };
    expectStorageError(
      () =>
        createSqliteDeletionIndex(transitionRaceDatabase, configuration).prepare({
          operationId: "operation:prepare-transition-race",
          authorityLineage: configuration.authorityLineage,
          expectedIndexGeneration: 0,
          targets: [target],
          artifactDigest: digest,
        }),
      "stale-authority",
      "Deletion authority is stale.",
    );
    transitionRace.close();

    const missing = new NodeSqliteTestDatabase();
    initializeDeletionIndex(missing, configuration);
    const missingIndex = createSqliteDeletionIndex(missing, configuration);
    const missingCheckpoint = await missingIndex.prepare({
      operationId: "operation:transition-missing",
      authorityLineage: configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [target],
      artifactDigest: digest,
    });
    expectStorageError(
      () => missingIndex.commit({ ...missingCheckpoint, operationId: "operation:unknown" }),
      "invalid-transition",
      "Index checkpoint is not current.",
    );
    expectStorageError(
      () =>
        missingIndex.failBeforeIntent({ ...missingCheckpoint, operationId: "operation:unknown" }),
      "invalid-transition",
      "Index checkpoint is not current.",
    );
    const noOpMissing: SqliteApplicationDatabase = {
      execute: missing.execute.bind(missing),
      readAll: missing.readAll.bind(missing),
      readOne: missing.readOne.bind(missing),
      transaction: (() => undefined) as SqliteApplicationDatabase["transaction"],
    };
    const noOpMissingIndex = createSqliteDeletionIndex(noOpMissing, configuration);
    expectStorageError(
      () => noOpMissingIndex.failBeforeIntent(missingCheckpoint),
      "invalid-transition",
      "Transition did not persist.",
    );
    missing.close();
  });
});
