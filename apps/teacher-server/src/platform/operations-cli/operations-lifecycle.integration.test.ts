import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

import { createMigrationCatalog } from "@marea/sqlite-storage";
import { migrationLedgerSql } from "@marea/sqlite-storage/migrations";

import { createRecoveryBundle } from "../recovery/recovery-bundle-service.js";
import {
  cleanupOperationsInstallations,
  operationsInstallation,
  preparePendingDeletion,
} from "./operations.fixture.js";

const outside: string[] = [];
afterEach(() => {
  cleanupOperationsInstallations();
  for (const root of outside.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A private directory outside the installation for isolated restores. */
function isolatedParent(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-restore-")));
  chmodSync(root, 0o700);
  outside.push(root);
  return root;
}

function schemaVersion(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

type Installation = ReturnType<typeof operationsInstallation>;

/** An operator's copy of a bundle kept outside the backup root. */
function offsite(f: Installation, bundle: string): string {
  const copy = join(f.root, "work", `${bundle.slice(bundle.lastIndexOf("/") + 1)}-offsite`);
  cpSync(bundle, copy, { recursive: true });
  return copy;
}

function restore(f: Installation, bundlePath: string, destinationRoot: string, name = "restore") {
  return f.run(
    "backup",
    "restore",
    "--input",
    f.work(`${name}.json`, { bundlePath, destinationRoot }),
  );
}

async function backup(f: Installation, name: string) {
  const created = await f.run("backup", "create", "--input", f.work(`${name}.json`, { name }));
  expect(created).toMatchObject({ code: 0, summary: { path: join(f.root, "backups", name) } });
  return join(f.root, "backups", name);
}

/** Deletes the closed run and the backups that contain it, as an operator confirms it. */
async function deleteClosedRun(f: Installation) {
  const blocked = join(f.root, "work", "blocked.json");
  const preview = (previewId: string, targets: readonly unknown[], output: string) =>
    f.run(
      "deletion",
      "preview",
      "--input",
      f.work(`${previewId.replace(":", "-")}.json`, {
        requestId: `request:${previewId}`,
        previewId,
        policyRevision: "policy:explicit",
        targets,
      }),
      "--output",
      output,
    );
  expect(await preview("preview:blocked", [f.runNode("run:closed")], blocked)).toMatchObject({
    code: 0,
  });
  const { blockers } = f.readWork("blocked.json") as {
    readonly blockers: readonly { readonly target: unknown }[];
  };
  const artifact = join(f.root, "work", "artifact.json");
  expect(
    await preview(
      "preview:delete",
      [f.runNode("run:closed"), ...blockers.map((blocker) => blocker.target)],
      artifact,
    ),
  ).toMatchObject({ code: 0, summary: { blockers: 0 } });
  expect(await f.run("deletion", "confirm", "--input", artifact)).toMatchObject({
    code: 0,
    summary: { state: "applied" },
  });
}

describe("installation lifecycle commands", () => {
  it("initializes only an installation without a database, privately and at the supported schema", async () => {
    const f = operationsInstallation();
    expect(await f.run("installation", "initialize")).toMatchObject({ code: 4, open: 0 });
    rmSync(f.config.databasePath);
    expect(await f.run("installation", "initialize")).toEqual({
      code: 0,
      open: 0,
      stderr: "",
      summary: { schemaVersion: 9 },
    });
    expect(statSync(f.config.databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(f.config.indexPath).mode & 0o777).toBe(0o600);
    expect(schemaVersion(f.config.databasePath)).toBe(9);
    expect(await f.run("installation", "initialize")).toMatchObject({ code: 4 });
    expect(await f.run("recovery", "inspect", "--input", f.work("idle.json", {}))).toMatchObject({
      code: 0,
      summary: { state: "none", reasonCode: "idle" },
    });

    // An interrupted initialization leaves an empty database that activation completes.
    rmSync(f.config.databasePath);
    rmSync(f.config.indexPath);
    writeFileSync(f.config.databasePath, "", { mode: 0o600 });
    expect(await f.run("installation", "initialize")).toMatchObject({ code: 4 });
    expect(await f.run("deletion", "activate")).toMatchObject({
      code: 0,
      summary: { schemaVersion: 9 },
    });
    rmSync(f.config.databasePath);
    rmSync(f.config.indexPath);
    expect(await f.run("deletion", "activate")).toMatchObject({
      code: 0,
      summary: { schemaVersion: 9 },
    });
    expect(statSync(f.config.databasePath).mode & 0o777).toBe(0o600);
  });

  it("backs up before activation and restores that bundle while no deletion was recorded", async () => {
    const f = operationsInstallation();
    const legacy = await backup(f, "pre-upgrade");
    const manifest = JSON.parse(readFileSync(join(legacy, "manifest.json"), "utf8")) as {
      readonly release: { readonly schemaVersion: number };
      readonly files: readonly unknown[];
    };
    expect([manifest.release.schemaVersion, manifest.files]).toEqual([8, []]);

    const parent = isolatedParent();
    expect(await restore(f, legacy, join(parent, "before-activation"))).toMatchObject({
      code: 0,
      open: 0,
      summary: {
        state: "restored",
        reasonCode: "none",
        schemaVersion: 8,
        checked: 0,
        tombstoned: 0,
        path: join(parent, "before-activation"),
      },
    });
    expect(schemaVersion(join(parent, "before-activation", "database.sqlite"))).toBe(8);

    expect(await f.run("deletion", "activate")).toMatchObject({ code: 0 });
    const upgraded = await backup(f, "upgraded");
    expect(await restore(f, legacy, join(parent, "rollback"))).toMatchObject({
      code: 0,
      summary: { state: "restored", reasonCode: "no-deletions-recorded", schemaVersion: 8 },
    });
    expect(await restore(f, upgraded, join(parent, "upgraded"))).toMatchObject({
      code: 0,
      summary: { state: "restored", reasonCode: "none", schemaVersion: 9 },
    });
    expect(schemaVersion(join(parent, "upgraded", "database.sqlite"))).toBe(9);
    // Existing destinations are never replaced.
    expect(await restore(f, upgraded, join(parent, "upgraded"))).toMatchObject({ code: 4 });
  });

  it("refuses restores that could resurrect deleted identities and removes their destination", async () => {
    const f = operationsInstallation();
    const legacy = offsite(f, await backup(f, "pre-upgrade"));
    expect(await f.run("deletion", "activate")).toMatchObject({ code: 0 });
    const upgraded = offsite(f, await backup(f, "upgraded"));
    await deleteClosedRun(f);
    const parent = isolatedParent();

    expect(await restore(f, upgraded, join(parent, "upgraded"))).toMatchObject({
      code: 0,
      open: 0,
      summary: {
        state: "blocked",
        reasonCode: "tombstoned-identity",
        schemaVersion: 9,
        tombstoned: 3,
        path: null,
      },
    });
    expect(await restore(f, legacy, join(parent, "rollback"))).toMatchObject({
      code: 0,
      summary: { state: "blocked", reasonCode: "unknown-ancestry", schemaVersion: 8, path: null },
    });
    expect([existsSync(join(parent, "upgraded")), existsSync(join(parent, "rollback"))]).toEqual([
      false,
      false,
    ]);
  });

  it("blocks unrecorded ancestry while a deletion is pending or the authority is not active", async () => {
    const f = operationsInstallation();
    const legacy = await backup(f, "pre-upgrade");
    expect(await f.run("deletion", "activate")).toMatchObject({ code: 0 });
    const parent = isolatedParent();
    const index = new DatabaseSync(f.config.indexPath);
    try {
      index.prepare("UPDATE marea_deletion_index_meta SET state = 'retired'").run();
    } finally {
      index.close();
    }
    const retired = await restore(f, legacy, join(parent, "retired"));
    expect(retired.summary).not.toMatchObject({ state: "restored" });
    expect(existsSync(join(parent, "retired"))).toBe(false);

    const pending = operationsInstallation();
    const pendingLegacy = await backup(pending, "pre-upgrade");
    expect(await pending.run("deletion", "activate")).toMatchObject({ code: 0 });
    await preparePendingDeletion(pending);
    expect(await restore(pending, pendingLegacy, join(parent, "pending"))).toMatchObject({
      code: 0,
      summary: { state: "blocked", reasonCode: "unknown-ancestry", path: null },
    });
    expect(existsSync(join(parent, "pending"))).toBe(false);
  });

  it("restores an older bundle into a legacy installation but never an activated one", async () => {
    const f = operationsInstallation();
    const legacy = await backup(f, "pre-upgrade");
    const other = operationsInstallation();
    expect(await other.run("deletion", "activate")).toMatchObject({ code: 0 });
    const activatedBundle = await backup(other, "activated");
    const parent = isolatedParent();
    expect(await restore(f, activatedBundle, join(parent, "foreign"))).toMatchObject({
      code: 0,
      summary: {
        state: "blocked",
        reasonCode: "missing-authority",
        schemaVersion: 9,
        checked: 0,
        tombstoned: 0,
        path: null,
      },
    });
    expect(existsSync(join(parent, "foreign"))).toBe(false);
    expect(await restore(f, legacy, join(parent, "legacy"))).toMatchObject({
      code: 0,
      summary: { state: "restored", schemaVersion: 8 },
    });
  });

  it("restores only into a private canonical directory outside the installation", async () => {
    const f = operationsInstallation();
    const legacy = await backup(f, "pre-upgrade");
    const parent = isolatedParent();
    const alias = join(parent, "alias");
    symlinkSync(f.root, alias);
    mkdirSync(join(parent, "public"), { mode: 0o755 });
    chmodSync(join(parent, "public"), 0o755);
    for (const destination of [
      join(f.root, "work", "inside"),
      f.root,
      parent.slice(0, parent.lastIndexOf("/")),
      join(alias, "restored"),
      join(alias, "work", "restored"),
      join(parent, "public", "restored"),
      join(parent, "missing", "restored"),
    ])
      expect(await restore(f, legacy, destination, "rejected")).toMatchObject({
        code: 2,
        open: 0,
      });
    expect(existsSync(join(f.root, "work", "inside"))).toBe(false);
  });

  it("refuses unsupported schemas for backup and restore", async () => {
    const f = operationsInstallation();
    // A genuine schema-7 database that SQLite restore could migrate is still not restored here.
    const olderPath = join(f.root, "work", "older.sqlite");
    const olderDatabase = new DatabaseSync(olderPath);
    try {
      olderDatabase.exec(migrationLedgerSql());
      for (const migration of createMigrationCatalog().slice(0, 7)) {
        for (const statement of migration.statements) olderDatabase.exec(statement);
        olderDatabase
          .prepare("INSERT INTO marea_schema_migrations (version, name, checksum) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, migration.checksum);
      }
      olderDatabase.exec("PRAGMA user_version = 7");
    } finally {
      olderDatabase.close();
    }
    const bytes = new Uint8Array(readFileSync(olderPath));
    const older = createRecoveryBundle(join(f.root, "work", "older-bundle"), {
      createBackup: {
        createBackup: () => ({
          bytes,
          format: "sqlite3",
          schemaVersion: 7,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      },
      createExclusive: (operation) => operation(),
      files: [],
      limits: f.config.limits,
      release: { id: "release:older", schemaVersion: 7 },
      sourceRoot: f.root,
    });
    const parent = isolatedParent();
    expect(await restore(f, older.path, join(parent, "older"))).toMatchObject({ code: 5 });
    expect(existsSync(join(parent, "older"))).toBe(false);

    const empty = operationsInstallation();
    rmSync(empty.config.databasePath);
    writeFileSync(empty.config.databasePath, "", { mode: 0o600 });
    expect(await backup(empty, "empty").catch(() => "refused")).toBe("refused");
    expect(
      await empty.run("backup", "create", "--input", empty.work("b.json", { name: "empty" })),
    ).toMatchObject({ code: 5 });
  });
});
