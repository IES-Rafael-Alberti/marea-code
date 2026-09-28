import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("./retention-bun-sqlite.fixture.js"));

import { existsSync } from "node:fs";
import { join } from "node:path";

import { deleteRetentionContent, removeRemainingRetentionContent } from "./retention-content.js";
import { readRetentionGraph } from "./retention-graph.js";
import { NOW, retentionHarness, rowCount } from "./retention.fixture.js";

const RUN_TABLES = [
  ["marea_runs", "id = 'run:closed'"],
  ["marea_run_events", "run_id = 'run:closed'"],
  ["marea_run_leases", "run_id = 'run:closed'"],
  ["marea_run_open_requests", "run_id = 'run:closed'"],
  ["marea_teacher_notices", "run_id = 'run:closed'"],
  ["marea_evaluations", "run_id = 'run:closed'"],
  ["marea_usage_accounts", "run_id = 'run:closed'"],
  ["marea_usage_attempts", "run_id = 'run:closed'"],
  ["marea_usage_tool_calls", "reservation_id = 'attempt:1'"],
  ["marea_run_snapshots", "id = 'snapshot:own'"],
  ["marea_run_teaching_snapshots", "snapshot_id = 'snapshot:own'"],
] as const;

describe("scoped permanent deletion", () => {
  it("previews a closed run closure without writing and deletes exactly that closure on confirmation", async () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    const before = RUN_TABLES.map(([table, where]) => rowCount(h.database, table, where));
    const artifact = await h.service.preview(h.request([run]));
    expect(artifact.blockers).toEqual([]);
    expect(artifact.targets.map((node) => node.kind)).toEqual(["run", "snapshot"]);
    expect(artifact.counts).toEqual({
      rows: before.reduce((a, b) => a + b, 0),
      files: 0,
      backups: 0,
    });
    expect((await h.service.preview(h.request([run]))).graphDigest).toBe(artifact.graphDigest);
    expect(RUN_TABLES.map(([table, where]) => rowCount(h.database, table, where))).toEqual(before);
    expect((await h.index.inspect()).generation).toBe(0);

    const confirmation = await h.service.confirm({ artifact, now: NOW, drainUntil: NOW });
    expect(confirmation).toMatchObject({ state: "applied", operationId: "preview:one" });
    expect(RUN_TABLES.map(([table, where]) => rowCount(h.database, table, where))).toEqual(
      RUN_TABLES.map(() => 0),
    );
    expect(rowCount(h.database, "marea_runs")).toBe(2);
    expect(rowCount(h.database, "marea_run_events", "run_id = 'run:other'")).toBe(1);
    expect((await h.index.inspect()).generation).toBe(1);
    expect(await h.index.assertCreatable(run)).toEqual({ allowed: false, code: "tombstoned" });
    expect(await h.service.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "applied",
    });
  });

  it("deletes a student account with its runs, governance rows and exclusive snapshots only", async () => {
    const h = retentionHarness();
    const student = h.observe("account", "student:one");
    const artifact = await h.service.preview(h.request([student]));
    expect(artifact.blockers).toEqual([]);
    expect(await h.service.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "applied",
    });
    for (const [table, where] of [
      ["marea_users", "id = 'student:one'"],
      ["marea_governance_accounts", "user_id = 'student:one'"],
      ["marea_center_memberships", "user_id = 'student:one'"],
      ["marea_governance_memberships", "user_id = 'student:one'"],
      ["marea_auth_sessions", "user_id = 'student:one'"],
      ["marea_invitations", "consumed_by = 'student:one'"],
      ["marea_runs", "student_id = 'student:one'"],
      ["marea_run_snapshots", "id = 'snapshot:own'"],
    ] as const)
      expect(rowCount(h.database, table, where)).toBe(0);
    expect(rowCount(h.database, "marea_users")).toBe(2);
    expect(rowCount(h.database, "marea_run_snapshots", "id = 'snapshot:shared'")).toBe(1);
    expect(rowCount(h.database, "marea_centers")).toBe(1);
    expect(h.dependencies.auditFor(h.database).audit.read("preview:one")).toMatchObject({
      state: "applied",
      errorCode: null,
    });
    const deleted = h.database.readAll(
      "SELECT disposition FROM marea_retention_dispositions WHERE operation_id = 'preview:one'",
    );
    expect(deleted.map((row) => row.disposition)).toEqual(artifact.targets.map(() => "deleted"));
    for (const node of artifact.targets)
      expect(await h.index.assertCreatable(node)).toEqual({ allowed: false, code: "tombstoned" });
  });

  it("disposes explicitly named backups together with the data they may contain", async () => {
    const h = retentionHarness();
    h.writeBackup("backup-a");
    const [backup] = h.backups.list();
    if (backup?.state !== "verified") throw new Error("The fixture backup must verify.");
    const run = h.observe("run", "run:closed");
    expect((await h.service.preview(h.request([run]))).blockers).toMatchObject([
      { code: "shared-backup", target: backup.target },
    ]);
    const artifact = await h.service.preview(h.request([run, backup.target], "preview:two"));
    expect(artifact.counts.backups).toBe(1);
    expect(await h.service.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "applied",
    });
    expect(existsSync(join(h.backupRoot, "backup-a"))).toBe(false);
    expect(rowCount(h.database, "marea_runs", "id = 'run:closed'")).toBe(0);
  });

  it("removes only the rows that remain when an interrupted deletion is continued", () => {
    const h = retentionHarness();
    const graph = readRetentionGraph(h.database, [], [h.observe("run", "run:closed")], NOW);
    expect(removeRemainingRetentionContent(h.database, graph.plan)).toBe(graph.counts.rows);
    expect(RUN_TABLES.map(([table, where]) => rowCount(h.database, table, where))).toEqual(
      RUN_TABLES.map(() => 0),
    );
    expect(removeRemainingRetentionContent(h.database, graph.plan)).toBe(0);
    expect(rowCount(h.database, "marea_runs")).toBe(2);
  });

  it("rolls back every row when the deleted count differs from the reviewed count", () => {
    const h = retentionHarness();
    const graph = readRetentionGraph(h.database, [], [h.observe("run", "run:closed")], NOW);
    const before = RUN_TABLES.map(([table, where]) => rowCount(h.database, table, where));
    expect(() => {
      deleteRetentionContent(h.database, graph.plan, graph.counts.rows + 1);
    }).toThrow("Retention deletion row count changed.");
    expect(RUN_TABLES.map(([table, where]) => rowCount(h.database, table, where))).toEqual(before);
  });
});
