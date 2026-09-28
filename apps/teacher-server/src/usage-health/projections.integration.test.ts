import { expect, it } from "vitest";
import { NOW } from "../../test-support/history-fixture.js";
import { teacher, student } from "../../test-support/teaching-integration.fixture.js";
import { useUsageHealthHarness, usageQuery, healthQuery } from "./usage-health.fixture.js";
const h = useUsageHealthHarness();

it("projects ledger charges, retries, evaluation and reservation uncertainty without foreign records", () => {
  h().attempt("a");
  h().ledger.settle("a", { inputTokens: 2, outputTokens: 3 }, NOW);
  h().attempt("b");
  h().ledger.settle("b", null, NOW);
  h().attempt("c", "run:a", "evaluation");
  h().attempt("foreign", "run:c");
  const first = h().service.queryUsage(teacher, usageQuery({ limit: 2 }));
  expect(first.nextAfterAttemptId).toBe("b");
  expect(first.pricing).toBe("complete");
  expect(first.entries).toEqual([
    {
      attemptId: "a",
      purpose: "tutoring",
      state: "settled",
      createdAt: NOW,
      settledAt: NOW,
      tokenBasis: "reported",
      inputTokens: 2,
      outputTokens: 3,
      cost: { status: "priced", unit: "synthetic-unit", units: 13 },
    },
    {
      attemptId: "b",
      purpose: "tutoring",
      state: "unknown",
      createdAt: NOW,
      settledAt: NOW,
      tokenBasis: "reservation",
      inputTokens: 10,
      outputTokens: 10,
      cost: { status: "priced", unit: "synthetic-unit", units: 50 },
    },
  ]);
  const second = h().service.queryUsage(teacher, usageQuery({ limit: 2, afterAttemptId: "b" }));
  expect(second.nextAfterAttemptId).toBeNull();
  expect(second.entries.map((e) => e.attemptId)).toEqual(["c"]);
  expect(second.entries[0]).toMatchObject({
    purpose: "evaluation",
    state: "reserved",
    tokenBasis: "reservation",
  });
  expect(
    h().service.queryUsage(teacher, usageQuery({ afterAttemptId: "foreign" })).entries,
  ).toEqual([]);
  h().ledger.settle("c", { inputTokens: 11, outputTokens: 2 }, NOW);
  expect(h().service.queryUsage(teacher, usageQuery()).entries[2]).toMatchObject({
    state: "breached",
    tokenBasis: "reported",
    cost: { units: 28 },
  });
});
it("represents missing, malformed, unsafe or inconsistent pricing without inventing zero", () => {
  h().attempt("a");
  h().ledger.settle("a", { inputTokens: 0, outputTokens: 0 }, NOW);
  h().attempt("b", "run:a", "evaluation");
  h().database.execute(
    "UPDATE marea_usage_accounts SET policy_json = '{}' WHERE purpose = 'evaluation'",
  );
  expect(h().service.queryUsage(teacher, usageQuery())).toMatchObject({
    pricing: "partial",
    entries: [{ cost: { status: "priced", units: 0 } }, { cost: { status: "unavailable" } }],
  });
  for (const policy of ["{", "null", '{"endpoint":"https://private.invalid"}']) {
    h().database.execute("UPDATE marea_usage_accounts SET policy_json = ?1", [policy]);
    expect(h().service.queryUsage(teacher, usageQuery()).pricing).toBe("unavailable");
  }
});
it("rejects inconsistent charges and private-looking units", () => {
  h().attempt("a");
  h().database.execute("UPDATE marea_usage_attempts SET cost_units = 49");
  expect(h().service.queryUsage(teacher, usageQuery()).entries[0]?.cost).toEqual({
    status: "unavailable",
  });
  h().database.execute("UPDATE marea_usage_attempts SET cost_units = 50");
  h().database.execute(
    "UPDATE marea_usage_accounts SET policy_json = json_set(policy_json, '$.costUnit', '/private/path')",
  );
  expect(h().service.queryUsage(teacher, usageQuery()).entries[0]?.cost).toEqual({
    status: "unavailable",
  });
});
it("filters inclusive start/exclusive end by instant and supports empty pages", () => {
  h().attempt("start", "run:a", "tutoring", "2026-09-07T00:00:00Z");
  h().attempt("end", "run:b", "tutoring", "2026-09-08T00:00:00Z");
  expect(
    h()
      .service.queryUsage(teacher, usageQuery())
      .entries.map((e) => e.attemptId),
  ).toEqual(["start"]);
  expect(
    h().service.queryUsage(
      teacher,
      usageQuery({ from: "2026-09-06T00:00:00Z", until: "2026-09-07T00:00:00Z" }),
    ),
  ).toMatchObject({ entries: [], pricing: "unavailable", nextAfterAttemptId: null });
});
it("checks role and current class membership on every read", () => {
  expect(() => h().service.queryUsage(student, usageQuery())).toThrow("dashboard.forbidden");
  expect(() => h().service.readHealth(teacher, healthQuery({ classId: "class:two" }))).toThrow(
    "dashboard.forbidden",
  );
  h().database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
  expect(() => h().service.queryUsage(teacher, usageQuery())).toThrow("dashboard.forbidden");
  expect(() => h().service.readHealth(teacher, healthQuery())).toThrow("dashboard.forbidden");
});
it("defines health as read evidence, never exporter configuration or a successful inference", () => {
  h().attempt("foreign", "run:c");
  expect(h().service.readHealth(teacher, healthQuery())).toMatchObject({
    storage: { status: "available", observedAt: NOW },
    usageLedger: { status: "unknown", observedAt: null },
    inference: { status: "unknown", observedAt: null },
    telemetryDelivery: { status: "unknown", observedAt: null },
  });
  h().attempt("a");
  for (const [now, status] of [
    [NOW, "available"],
    ["2026-09-07T12:05:00Z", "available"],
    ["2026-09-07T12:05:00.001Z", "stale"],
    ["2026-09-07T11:59:59Z", "unknown"],
  ] as const) {
    h().time.value = now;
    expect(h().service.readHealth(teacher, healthQuery()).usageLedger.status).toBe(status);
  }
  for (const created of ["invalid", "2026-09-07", "2026-09-07T12:00:00+00:00"]) {
    h().database.execute("UPDATE marea_usage_attempts SET created_at = ?1 WHERE id = 'a'", [
      created,
    ]);
    expect(h().service.readHealth(teacher, healthQuery()).usageLedger).toEqual({
      status: "unknown",
      observedAt: null,
    });
  }
});
it("enforces governed membership, account and center revocation even with stale legacy joins", () => {
  h().database.execute("INSERT INTO marea_centers VALUES ('center','Synthetic','v',?1,?1)", [NOW]);
  h().database.execute(
    "INSERT INTO marea_governance_classes VALUES ('class:one','center','v',?1,?1)",
    [NOW],
  );
  h().database.execute(
    "INSERT INTO marea_governance_accounts VALUES ('t1','center','active','v',?1,?1)",
    [NOW],
  );
  h().database.execute(
    "INSERT INTO marea_center_memberships VALUES ('center','t1','administrator','active','v',?1,?1)",
    [NOW],
  );
  // Administrator alone and a stale legacy class join do not grant a governed class.
  expect(() => h().service.readHealth(teacher, healthQuery())).toThrow("dashboard.forbidden");
  h().database.execute(
    "INSERT INTO marea_governance_memberships VALUES ('class:one','center','t1','teacher','active','v',?1,?1)",
    [NOW],
  );
  expect(h().service.queryUsage(teacher, usageQuery()).entries).toEqual([]);
  for (const [table, column, denied] of [
    ["marea_governance_memberships", "state", "revoked"],
    ["marea_center_memberships", "state", "revoked"],
    ["marea_governance_accounts", "state", "disabled"],
  ] as const) {
    h().database.execute(`UPDATE ${table} SET ${column} = ?1`, [denied]);
    expect(() => h().service.queryUsage(teacher, usageQuery())).toThrow("dashboard.forbidden");
    expect(() => h().service.readHealth(teacher, healthQuery())).toThrow("dashboard.forbidden");
    h().database.execute(`UPDATE ${table} SET ${column} = 'active'`);
  }
});
it("keeps exact page boundaries and binary cursors, including a one-entry page", () => {
  h().attempt("A");
  h().ledger.settle("A", { inputTokens: 1, outputTokens: 1 }, NOW);
  h().attempt("B");
  expect(h().service.queryUsage(teacher, usageQuery({ limit: 1 }))).toMatchObject({
    nextAfterAttemptId: "A",
    entries: [{ attemptId: "A" }],
  });
  expect(h().service.queryUsage(teacher, usageQuery({ limit: 2 }))).toMatchObject({
    nextAfterAttemptId: null,
    entries: [{ attemptId: "A" }, { attemptId: "B" }],
  });
  expect(
    h().service.queryUsage(teacher, usageQuery({ afterAttemptId: "A", limit: 1 })),
  ).toMatchObject({ nextAfterAttemptId: null, entries: [{ attemptId: "B" }] });
  expect(() => h().service.readHealth({ ...teacher, role: "student" }, healthQuery())).toThrow(
    "dashboard.forbidden",
  );
});
