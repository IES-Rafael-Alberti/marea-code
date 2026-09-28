import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("./retention-bun-sqlite.fixture.js"));

import type { TargetRef } from "../schemas.js";
import type { InventoriedBackup } from "./retention-backups.boundary.js";
import { readRetentionGraph, retentionGraphReader } from "./retention-graph.js";
import { EARLIER, LATER, NOW, retentionHarness, target } from "./retention.fixture.js";

type Harness = ReturnType<typeof retentionHarness>;

function graphOf(
  h: Harness,
  targets: readonly TargetRef[],
  inventory: readonly InventoriedBackup[] | null = h.backups.list(),
) {
  return readRetentionGraph(h.database, inventory, targets, NOW);
}

function reasons(result: ReturnType<typeof graphOf>) {
  return result.graph.blockers.map((entry) => [entry.code, entry.detailCode]);
}

function identities(result: ReturnType<typeof graphOf>) {
  return result.graph.nodes.map((node) => [node.kind, Object.values(node.key).join("/")]);
}

describe("retention reference graph", () => {
  it("measures the complete closure of a closed run with an exclusive snapshot", () => {
    const h = retentionHarness();
    const result = graphOf(h, [h.observe("run", "run:closed")]);
    expect(identities(result)).toEqual([
      ["run", "run:closed"],
      ["snapshot", "snapshot:own"],
    ]);
    expect(result.graph.blockers).toEqual([]);
    expect(result.counts).toEqual({ rows: 12, files: 0, backups: 0 });
    expect(result.bytes).toEqual({ database: 92, files: 0, backups: 0 });
    expect(result.plan).toEqual({
      runIds: ["run:closed"],
      snapshotIds: ["snapshot:own"],
      accountIds: [],
      backupNames: [],
    });
    expect(result.graph.digest).toMatchInlineSnapshot(
      `"sha256:c2c32a249a2aad1d82a98ca3dabc65c1454375c3760c5cd4a21f95fb8f53d7bd"`,
    );
  });

  it("serves the maintenance graph port from the current database, inventory and clock", async () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    const reader = retentionGraphReader(
      h.database,
      () => null,
      () => NOW,
    );
    expect(await reader.read({ targets: [run] })).toEqual(
      readRetentionGraph(h.database, null, [run], NOW).graph,
    );
  });

  it("keeps a snapshot until every run using it is inside the closure", () => {
    const h = retentionHarness();
    const shared = h.observe("run", "run:shared");
    expect(graphOf(h, [shared]).plan.snapshotIds).toEqual([]);
    const both = graphOf(h, [shared, h.observe("run", "run:other")]);
    expect(both.plan).toMatchObject({
      runIds: ["run:other", "run:shared"],
      snapshotIds: ["snapshot:shared"],
    });
    expect(both.counts.rows).toBe(4);
    expect(both.bytes.database).toBe(41);
  });

  it("blocks runs that are open, active, leased, evaluating or unsettled", () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    h.database.execute("UPDATE marea_runs SET state = 'active', closed_at = NULL WHERE id = ?1", [
      "run:closed",
    ]);
    h.database.execute(
      "INSERT INTO marea_active_runs (run_id, student_id, class_id, project_display_name, started_at, last_activity_at, highest_durable_sequence, pending_approval) VALUES ('run:closed', 'student:one', 'class:one', 'Project', ?1, ?1, 2, 0)",
      [EARLIER],
    );
    h.database.execute(
      "INSERT INTO marea_run_leases (id, run_id, student_id, token_hash, issued_at, expires_at, revoked_at) VALUES ('lease:live', 'run:closed', 'student:one', 'live', ?1, ?2, NULL), ('lease:expired', 'run:closed', 'student:one', 'expired', ?1, ?3, NULL)",
      [EARLIER, LATER, NOW],
    );
    h.database.execute("UPDATE marea_evaluations SET state = 'queued' WHERE id = 'evaluation:1'");
    h.database.execute("UPDATE marea_usage_attempts SET state = 'reserved' WHERE id = 'attempt:1'");
    const result = graphOf(h, [run]);
    expect(reasons(result)).toEqual([
      ["active", "evaluation-pending"],
      ["active", "lease-live"],
      ["active", "run-active"],
      ["active", "run-open"],
      ["unknown", "usage-unsettled"],
    ]);
    expect(result.graph.blockers[0]?.target).toEqual(run);
    expect(result.counts.rows).toBe(15);
    expect(result.graph.digest).toMatchInlineSnapshot(
      `"sha256:75d2fd743a734607467c400e03f6d6371dfeefe7f715af17cff0dd58714d8699"`,
    );
  });

  it("protects privileged, referenced or signed-in accounts", () => {
    const h = retentionHarness();
    expect(reasons(graphOf(h, [h.observe("account", "teacher:one")]))).toEqual([
      ["protected", "teacher-account"],
    ]);
    const student = h.observe("account", "student:one");
    h.database.execute(
      "UPDATE marea_center_memberships SET capability = 'administrator' WHERE user_id = 'student:one'",
    );
    h.database.execute(
      "INSERT INTO marea_governance_audit (request_id, actor_user_id, authority, center_id, operation, target_id, result_version, occurred_at) VALUES ('request', 'student:one', 'administrator', 'center:one', 'rename', 'class:one', 'v', ?1)",
      [EARLIER],
    );
    h.database.execute(
      "INSERT INTO marea_class_teaching_revisions (id, class_id, created_by, created_at, configuration_json, authority) VALUES ('revision:1', 'class:one', 'student:one', ?1, '{}', 'teacher')",
      [EARLIER],
    );
    h.database.execute(
      "INSERT INTO marea_class_exchange_previews (id, center_id, class_id, authority, user_id, session_id, expected_class_version, operator_fingerprint, package_digest, created_at, expires_at, state) VALUES ('exchange:1', 'center:one', 'class:one', 'administrator', 'student:one', 'session:old', 'class:v1', 'fp', 'digest', ?1, ?2, 'cancelled')",
      [EARLIER, LATER],
    );
    h.database.execute(
      "INSERT INTO marea_auth_sessions (id, user_id, token_hash, issued_at, expires_at, revoked_at) VALUES ('session:live', 'student:one', 'live', ?1, ?2, NULL), ('session:expired', 'student:one', 'expired', ?1, ?3, NULL)",
      [EARLIER, LATER, NOW],
    );
    expect(reasons(graphOf(h, [student]))).toEqual([
      ["active", "session-live"],
      ["protected", "administrator"],
      ["protected", "audit-actor"],
      ["protected", "exchange-preview"],
      ["protected", "teaching-author"],
    ]);
  });

  it("includes every run, membership and exclusive snapshot of a student account", () => {
    const h = retentionHarness();
    const student = h.observe("account", "student:one");
    expect(student.observed).toEqual({ kind: "version", version: "account:v1" });
    const result = graphOf(h, [student]);
    // Nodes sort by canonical identity bytes, whose `key` member precedes `kind`.
    expect(identities(result)).toEqual([
      ["center-membership", "center:one/student:one"],
      ["class-membership", "class:one/student:one"],
      ["run", "run:closed"],
      ["run", "run:shared"],
      ["snapshot", "snapshot:own"],
      ["account", "student:one"],
    ]);
    expect(result.graph.nodes[0]?.observed).toEqual({
      kind: "version",
      version: "center-member:v1",
    });
    expect(result.graph.nodes[1]?.observed).toEqual({
      kind: "version",
      version: "class-member:v1",
    });
    expect(result.graph.blockers).toEqual([]);
    expect(result.counts.rows).toBe(19);
    expect(result.plan).toEqual({
      runIds: ["run:closed", "run:shared"],
      snapshotIds: ["snapshot:own"],
      accountIds: ["student:one"],
      backupNames: [],
    });
    expect(result.graph.digest).toMatchInlineSnapshot(
      `"sha256:41a73c0fb17a9c2ddebc33b907656fc4908f05808efce112a39a98964c5b1497"`,
    );
    const everyone = graphOf(h, [student, h.observe("account", "student:two")]);
    expect(everyone.plan.snapshotIds).toEqual(["snapshot:own", "snapshot:shared"]);
  });

  it("observes an account without governance through its user row", () => {
    const h = retentionHarness();
    const before = h.observe("account", "student:two");
    expect(before.observed).toMatchObject({ kind: "version" });
    expect(JSON.stringify(before.observed)).toMatch(/"version":"sha256:[0-9a-f]{64}"/u);
    expect(graphOf(h, [before]).counts.rows).toBe(1 + 2);
    h.database.execute("UPDATE marea_users SET display_name = 'Renamed' WHERE id = 'student:two'");
    expect(reasons(graphOf(h, [before]))).toEqual([["stale", "observation-changed"]]);
  });

  it("reports missing, unsupported and changed targets without resolving them", () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    const missingRun = target({
      ...run,
      key: { runId: "run:missing" },
      observed: { ...run.observed, runId: "run:missing" },
    });
    const missingAccount = target({
      kind: "account",
      key: { userId: "student:missing" },
      observed: { kind: "version", version: "v" },
    });
    const snapshot = graphOf(h, [run]).graph.nodes[1];
    if (snapshot === undefined) throw new Error("The run closure must contain its snapshot.");
    const result = graphOf(h, [missingRun, missingAccount, snapshot]);
    expect(result.graph.nodes).toEqual([]);
    expect(result.graph.blockers).toEqual([
      { code: "unknown", target: missingRun, detailCode: "unresolved-target" },
      { code: "unknown", target: missingAccount, detailCode: "unresolved-target" },
      { code: "unknown", target: snapshot, detailCode: "unsupported-target" },
    ]);
    h.database.execute(
      "UPDATE marea_run_snapshots SET public_snapshot_json = '{\"project\":\"changed\"}' WHERE id = 'snapshot:own'",
    );
    expect(reasons(graphOf(h, [run]))).toEqual([["stale", "observation-changed"]]);
  });

  it("previews long histories and large snapshots beyond canonical encoder limits", () => {
    const h = retentionHarness();
    h.database.execute(
      "UPDATE marea_run_snapshots SET public_snapshot_json = ?1 WHERE id = 'snapshot:own'",
      [JSON.stringify({ project: "x".repeat(300_000) })],
    );
    for (let index = 0; index < 3_000; index += 1)
      h.database.execute(
        "INSERT INTO marea_auth_sessions (id, user_id, token_hash, issued_at, expires_at, revoked_at) VALUES (?1, 'student:one', ?1, ?2, ?3, ?2)",
        [`session:${String(index)}`, EARLIER, LATER],
      );
    const result = graphOf(h, [h.observe("account", "student:one")]);
    expect(result.graph.blockers).toEqual([]);
    expect(result.counts.rows).toBe(19 + 3_000);
  });

  it("changes the digest when any derived row changes", () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    const student = h.observe("account", "student:one");
    const digests = new Set<string>();
    const record = () => {
      const result = graphOf(h, [run, student]);
      expect(result.graph.blockers).toEqual([]);
      digests.add(result.graph.digest);
    };
    const changes = [
      "UPDATE marea_runs SET closed_at = '2026-09-14T09:30:00.000Z' WHERE id = 'run:closed'",
      "INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json) VALUES ('event:4', 'run:closed', 3, '2026-09-14T09:00:00.000Z', 'message', '{}')",
      "UPDATE marea_evaluations SET updated_at = '2026-09-14T09:30:00.000Z' WHERE id = 'evaluation:1'",
      "UPDATE marea_teacher_notices SET acknowledged_at = '2026-09-14T09:30:00.000Z' WHERE id = 'notice:1'",
      "UPDATE marea_usage_attempts SET state = 'breached' WHERE id = 'attempt:1'",
      "UPDATE marea_run_leases SET expires_at = '2026-09-14T12:00:00.000Z' WHERE id = 'lease:revoked'",
      "INSERT INTO marea_usage_accounts (run_id, purpose, policy_json, created_at) VALUES ('run:closed', 'evaluation', '{}', '2026-09-14T09:00:00.000Z')",
      "INSERT INTO marea_run_open_requests (student_id, idempotency_key, fingerprint, run_id) VALUES ('student:one', 'open:2', 'fp', 'run:closed')",
      "UPDATE marea_run_teaching_snapshots SET teaching_json = '{\"teaching\":false}' WHERE snapshot_id = 'snapshot:own'",
      "UPDATE marea_governance_accounts SET state = 'disabled' WHERE user_id = 'student:one'",
      "UPDATE marea_auth_sessions SET expires_at = '2026-09-14T09:30:00.000Z' WHERE id = 'session:old'",
      "INSERT INTO marea_invitations (code_hash, class_id, consumed_at, consumed_by) VALUES ('invitation:2', 'class:one', '2026-09-14T09:00:00.000Z', 'student:one')",
    ];
    record();
    for (const change of changes) {
      h.database.execute(change);
      record();
    }
    expect(digests.size).toBe(changes.length + 1);
  });

  it("requires a verifiable backup root and makes every other backup part of the decision", () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    const unreadable = graphOf(h, [run], null);
    expect(unreadable.graph.blockers).toEqual([
      { code: "unverifiable", target: null, detailCode: "backup-root" },
    ]);
    expect(unreadable.counts.backups).toBe(0);
    expect(unreadable.bytes.backups).toBe(0);
    expect(unreadable.plan.backupNames).toEqual([]);
    h.writeBackup("backup-a");
    h.writeBackup("backup-b");
    h.writeBackup("not a bundle");
    const inventory = h.backups.list();
    const [a, b] = inventory.flatMap((entry) => (entry.state === "verified" ? [entry] : []));
    if (a === undefined || b === undefined) throw new Error("The fixture backups must verify.");
    expect(reasons(graphOf(h, [run], inventory))).toEqual([
      ["shared-backup", "shared-backup"],
      ["shared-backup", "shared-backup"],
      ["unverifiable", "backup-unverifiable"],
    ]);
    const valid = [a, b];
    expect(reasons(graphOf(h, [a.target], [b]))).toEqual([["unknown", "unresolved-target"]]);
    const onlyBackup = graphOf(h, [a.target], valid);
    expect(onlyBackup.graph.blockers).toEqual([]);
    expect(onlyBackup.graph.nodes).toEqual([a.target]);
    expect(onlyBackup.counts).toEqual({ rows: 0, files: 0, backups: 1 });
    expect(onlyBackup.bytes.backups).toBe(a.bytes);
    expect(a.bytes).toBeGreaterThan(0);
    const all = graphOf(h, [run, a.target, b.target], valid);
    expect(all.graph.blockers).toEqual([]);
    expect(all.plan.backupNames).toEqual(["backup-a", "backup-b"]);
    expect(all.bytes.backups).toBe(a.bytes + b.bytes);
  });
});
