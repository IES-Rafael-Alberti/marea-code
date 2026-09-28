import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

import { cleanupOperationsInstallations, operationsInstallation } from "./operations.fixture.js";

afterEach(cleanupOperationsInstallations);

describe("private operations commands", () => {
  it("activates, backs up, previews, confirms and reconciles a deletion end to end", async () => {
    const f = operationsInstallation();
    const request = f.work("request.json", {
      requestId: "request:one",
      previewId: "preview:one",
      policyRevision: "policy:explicit",
      targets: [f.runNode("run:closed")],
    });
    expect(
      await f.run(
        "deletion",
        "preview",
        "--input",
        request,
        "--output",
        join(f.root, "work/a.json"),
      ),
    ).toMatchObject({ code: 5 });
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(await f.run("deletion", "activate")).toEqual({
        code: 0,
        open: 0,
        stderr: "",
        summary: { schemaVersion: 9 },
      });
    expect(await f.run("recovery", "inspect", "--input", f.work("inspect.json", {}))).toMatchObject(
      {
        code: 0,
        summary: { state: "none", operationId: null, checkpointState: null, reasonCode: "idle" },
      },
    );

    const backup = await f.run(
      "backup",
      "create",
      "--input",
      f.work("backup.json", { name: "backup-a" }),
    );
    expect(backup).toMatchObject({
      code: 0,
      summary: { path: join(f.root, "backups/backup-a"), files: 1 },
    });
    const offsite = join(f.root, "work", "backup-a-copy");
    cpSync(join(f.root, "backups/backup-a"), offsite, { recursive: true });
    const restored = join(f.root, "work", "restored.sqlite");
    const source = new DatabaseSync(f.config.databasePath);
    source.prepare("VACUUM INTO ?1").run(restored);
    source.close();

    const blocked = await f.run(
      "deletion",
      "preview",
      "--input",
      request,
      "--output",
      join(f.root, "work/blocked.json"),
    );
    expect(blocked).toMatchObject({
      code: 0,
      summary: { previewId: "preview:one", blockers: 1, backups: 0 },
    });
    expect(
      await f.run("deletion", "confirm", "--input", join(f.root, "work/blocked.json")),
    ).toMatchObject({ code: 4 });

    const shared = f.readWork("blocked.json") as {
      readonly blockers: readonly { readonly target: unknown }[];
    };
    const requestWithBackup = f.work("request-backup.json", {
      requestId: "request:two",
      previewId: "preview:two",
      policyRevision: "policy:explicit",
      targets: [f.runNode("run:closed"), shared.blockers[0]?.target],
    });
    const artifact = join(f.root, "work/artifact.json");
    expect(
      await f.run("deletion", "preview", "--input", requestWithBackup, "--output", artifact),
    ).toMatchObject({ code: 0, summary: { previewId: "preview:two", blockers: 0, backups: 1 } });
    expect(await f.run("deletion", "confirm", "--input", artifact)).toMatchObject({
      code: 0,
      summary: { operationId: "preview:two", state: "applied" },
    });
    expect(existsSync(join(f.root, "backups/backup-a"))).toBe(false);
    expect(await f.run("deletion", "confirm", "--input", artifact)).toMatchObject({
      code: 0,
      summary: { state: "applied" },
    });
    expect(
      await f.run(
        "recovery",
        "inspect",
        "--input",
        f.work("inspect-op.json", { operationId: "preview:two" }),
      ),
    ).toMatchObject({ code: 0, summary: { state: "applied", reasonCode: "audit-record" } });

    const reconcile = (bundlePath: string) =>
      f.run(
        "backup",
        "reconcile",
        "--input",
        f.work("reconcile.json", { bundlePath, restoredDatabasePath: restored }),
      );
    expect(await reconcile(offsite)).toMatchObject({
      code: 0,
      open: 0,
      summary: {
        state: "blocked",
        reasonCode: "tombstoned-identity",
        currentIndexGeneration: 1,
        tombstoned: 3,
      },
    });
  });

  it("rejects malformed inputs and reports recovery guards without changes", async () => {
    const f = operationsInstallation();
    expect(await f.run("deletion", "activate")).toMatchObject({ code: 0 });
    expect(
      await f.run("backup", "create", "--input", f.work("bad-name.json", { name: "../escape" })),
    ).toMatchObject({ code: 2 });
    expect(
      await f.run("backup", "create", "--input", f.work("nested.json", { name: "ok/../../x" })),
    ).toMatchObject({ code: 2 });
    expect(
      await f.run(
        "recovery",
        "continue",
        "--input",
        f.work("unknown.json", {
          operationId: "preview:unknown",
          expectedIndexGeneration: 0,
          artifactDigest: `sha256:${"a".repeat(64)}`,
        }),
      ),
    ).toMatchObject({ code: 0, summary: { state: "blocked", reasonCode: "evidence-mismatch" } });
    expect(
      await f.run(
        "recovery",
        "mark-failed",
        "--input",
        f.work("unknown-fail.json", {
          operationId: "preview:unknown",
          expectedIndexGeneration: 0,
        }),
      ),
    ).toMatchObject({ code: 0, summary: { state: "blocked", reasonCode: "evidence-mismatch" } });
    expect(
      await f.run("recovery", "inspect", "--input", f.work("extra.json", { other: true })),
    ).toMatchObject({ code: 2 });
  });

  it("activates only against a matching index and never replaces a foreign one", async () => {
    const f = operationsInstallation();
    writeFileSync(f.config.indexPath, "not a database", { mode: 0o600 });
    const failed = await f.run("deletion", "activate");
    expect(failed.code).not.toBe(0);
    expect(failed.open).toBe(0);
    expect(readFileSync(f.config.indexPath, "utf8")).toBe("not a database");
    const database = new DatabaseSync(f.config.databasePath);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    database.close();
  });
});
