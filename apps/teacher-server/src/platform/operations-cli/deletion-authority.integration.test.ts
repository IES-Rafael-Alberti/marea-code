import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RequestIdSchema } from "@marea/protocol";
import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
vi.mock("../../identity/password-hasher.boundary.js", () => ({
  bunArgon2idPasswordHasher: {
    hash: (secret: string) => Promise.resolve(`synthetic-hash:${secret}`),
    verify: () => Promise.resolve(true),
  },
}));

import { CLI_NOW } from "../operator-cli/application.fixture.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import { nativeOpens } from "../operator-cli/bun-sqlite.fixture.js";
import { composeInstallation, createOperatorCliApplication } from "../operator-cli/composition.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { installationFixture } from "../operator-cli/installation.fixture.js";
import { TargetRefSchema } from "../operations/schemas.js";
import { parseStorageConfiguration } from "../operations/storage/configuration.js";
import * as deletionIndex from "../operations/storage/sqlite-deletion-index.js";
import { createSqliteDeletionIndex } from "../operations/storage/sqlite-deletion-index.js";
import { createOperationsApplication } from "./operations-application.js";
import { readOperationsConfig } from "./operations-config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  nativeOpens.length = 0;
});

function activatedInstallation() {
  const f = installationFixture();
  roots.push(f.root);
  mkdirSync(join(f.root, "backups"), { mode: 0o700 });
  const operations = {
    version: 1,
    databasePath: f.databasePath,
    indexPath: join(f.root, "deletion-index.sqlite"),
    backupRoot: join(f.root, "backups"),
    authorityLineage: "lineage:cli",
    rootId: "root:cli",
    databaseLineage: `sha256:${"c".repeat(64)}`,
    releaseId: "release:one",
    limits: { fileCount: 4, fileBytes: 1_000_000, totalBytes: 2_000_000 },
    stateFiles: [],
  };
  const writeOperations = (value: unknown) => {
    writeFileSync(join(f.root, "config", "operations.json"), JSON.stringify(value), {
      mode: 0o600,
    });
  };
  writeOperations(operations);
  const owned = acquireInstallation(f.root);
  createOperationsApplication(
    owned.capability,
    readOperationsConfig(f.root),
    () => CLI_NOW,
  ).activate();
  owned.release();
  return { ...f, operations, writeOperations };
}

async function retire(f: ReturnType<typeof activatedInstallation>, userId: string) {
  const config = readOperationsConfig(f.root);
  const file = openSqliteDatabaseFile({ databasePath: config.indexPath });
  try {
    const index = createSqliteDeletionIndex(
      file.database,
      parseStorageConfiguration({
        installationRoot: f.root,
        databasePath: config.databasePath,
        indexPath: config.indexPath,
        authorityLineage: config.authorityLineage,
        rootId: config.rootId,
        databaseLineage: config.databaseLineage,
      }),
    );
    const prepared = await index.prepare({
      operationId: "operation:retire",
      authorityLineage: config.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [
        TargetRefSchema.parse({
          kind: "account",
          key: { userId },
          observed: { kind: "version", version: "revision:retired" },
        }),
      ],
      artifactDigest: config.databaseLineage,
    });
    await index.completeContent(await index.startContent(await index.commit(prepared)));
  } finally {
    file.close();
  }
}

describe("operator CLI after OPERATIONS activation", () => {
  it("keeps an unactivated installation on the application catalog", () => {
    const f = installationFixture();
    roots.push(f.root);
    const owned = acquireInstallation(f.root);
    composeInstallation(owned.capability).close();
    owned.release();
    const database = new DatabaseSync(f.databasePath);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    database.close();
  });

  it("opens the activated catalog and refuses to recreate retired accounts", async () => {
    const f = activatedInstallation();
    await retire(f, "user:retired");
    const owned = acquireInstallation(f.root);
    const composed = composeInstallation(owned.capability);
    const context = {
      authority: owned.capability,
      now: CLI_NOW,
      requestId: RequestIdSchema.parse("request:test"),
    };
    await composed.application.createCenter({
      ...context,
      centerId: "center:a",
      displayName: "Center",
      expectedVersion: null,
    });
    const create = (userId: string, login: string) =>
      composed.application.createAccount({
        ...context,
        centerId: "center:a",
        userId,
        displayName: "Teacher",
        login,
        role: "teacher",
        classId: null,
        expectedVersion: null,
      });
    await expect(create("user:retired", "retired")).rejects.toMatchObject({
      code: "request.conflict",
    });
    expect(await create("user:fresh", "fresh")).toMatchObject({ userId: "user:fresh" });
    expect(composed.reserved).toEqual(
      expect.arrayContaining([
        f.operations.indexPath,
        `${f.operations.indexPath}-wal`,
        `${f.operations.indexPath}-shm`,
        `${f.operations.indexPath}-journal`,
      ]),
    );
    composed.close();
    expect(nativeOpens.every((record) => record.closed)).toBe(true);
    expect(owned.release()).toBe(true);
  });

  it("refuses foreign or incomplete deletion authority and closes every handle", () => {
    const f = activatedInstallation();
    const owned = acquireInstallation(f.root);
    const refuse = () => {
      let caught: unknown;
      try {
        createOperatorCliApplication(owned.capability, f.config);
      } catch (error) {
        caught = error;
      }
      expect(caught).toEqual(new OperatorCliError("prerequisite-unavailable"));
      expect(nativeOpens.every((record) => record.closed)).toBe(true);
    };
    const setState = (state: string) => {
      const index = new DatabaseSync(f.operations.indexPath);
      index.prepare("UPDATE marea_deletion_index_meta SET state = ?").run(state);
      index.close();
    };
    const other = join(f.root, "work", "other.sqlite");
    writeFileSync(other, "", { mode: 0o600 });
    f.writeOperations({ ...f.operations, databasePath: other });
    refuse();
    f.writeOperations({ ...f.operations, unexpected: true });
    refuse();
    f.writeOperations({ ...f.operations, indexPath: join(f.root, "missing-index.sqlite") });
    refuse();
    f.writeOperations(f.operations);
    for (const state of ["transfer-prepared", "retired"]) {
      setState(state);
      refuse();
    }
    // An inconsistent index is still composed; its creation gate refuses new accounts.
    f.writeOperations({ ...f.operations, rootId: "root:elsewhere" });
    setState("active");
    createOperatorCliApplication(owned.capability, f.config).close();
    expect(nativeOpens.every((record) => record.closed)).toBe(true);
    f.writeOperations(f.operations);
    writeFileSync(f.operatorPolicyPath, "invalid private policy");
    expect(() => createOperatorCliApplication(owned.capability, f.config)).toThrow();
    expect(nativeOpens.every((record) => record.closed)).toBe(true);
    writeFileSync(f.operatorPolicyPath, JSON.stringify(f.document), { mode: 0o600 });
    const database = new DatabaseSync(f.databasePath);
    database.exec("DROP TABLE marea_retention_dispositions");
    database.close();
    expect(() => createOperatorCliApplication(owned.capability, f.config)).toThrow();
    expect(nativeOpens.every((record) => record.closed)).toBe(true);
    owned.release();
  });
});

it("closes the deletion database when creation-gate composition fails", () => {
  const f = activatedInstallation();
  const owned = acquireInstallation(f.root);
  const guard = vi.spyOn(deletionIndex, "createSqliteCreationGate").mockImplementationOnce(() => {
    throw new Error("synthetic creation-gate failure");
  });
  try {
    expect(() => createOperatorCliApplication(owned.capability, f.config)).toThrow(
      "synthetic creation-gate failure",
    );
    expect(nativeOpens.every((record) => record.closed)).toBe(true);
  } finally {
    guard.mockRestore();
    owned.release();
  }
});
