import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NOW, setup } from "../../../test-support/history-fixture.js";
import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import {
  USAGE_ACCOUNT as account,
  USAGE_POLICY as policy,
} from "../../../test-support/usage-fixture.js";
import { SqliteUsageLedger } from "./sqlite-usage-ledger.js";

function input(id = "attempt:one") {
  return { ...account, reservationId: id, requestId: "request:one", attempt: 1, now: NOW };
}

describe("durable inference reservations", () => {
  it("enforces one shared tool allowance across attempts without charging the same call twice", () => {
    const { database } = setup();
    try {
      const ledger = new SqliteUsageLedger(database);
      ledger.configure(account, policy, NOW);
      ledger.reserve(input());
      expect(ledger.consumeToolCall("attempt:one", "call:one")).toBe(true);
      expect(ledger.consumeToolCall("attempt:one", "call:one")).toBe(true);
      expect(ledger.consumeToolCall("attempt:one", "call:two")).toBe(false);
      ledger.settle("attempt:one", null, NOW);
      expect(() => ledger.consumeToolCall("attempt:one", "call:one")).toThrow("request.conflict");
      expect(() => ledger.consumeToolCall("attempt:missing", "call:one")).toThrow(
        "request.conflict",
      );
      ledger.reserve({ ...input("attempt:two"), attempt: 2 });
      expect(ledger.consumeToolCall("attempt:two", "call:one")).toBe(false);
      const evaluation = { ...account, purpose: "evaluation" as const };
      ledger.configure(evaluation, { ...policy, maxToolCalls: 0 }, NOW);
      ledger.reserve({ ...input("attempt:evaluation"), ...evaluation });
      expect(ledger.consumeToolCall("attempt:evaluation", "call:one")).toBe(false);
      expect(database.readAll("SELECT call_id FROM marea_usage_tool_calls")).toEqual([
        { call_id: "call:one" },
      ]);
    } finally {
      database.close();
    }
  });

  it("fails closed without configuration, freezes policy and atomically excludes competing admissions", () => {
    const { database } = setup();
    try {
      const ledger = new SqliteUsageLedger(database);
      expect(ledger.totals(account)).toEqual({ requests: 0, tokens: 0, costUnits: 0, inFlight: 0 });
      expect(ledger.reserve(input())).toEqual({ admitted: false, reason: "unconfigured" });
      ledger.configure(account, policy, NOW);
      ledger.configure(account, policy, "2026-09-08T12:00:00.000Z");
      expect(() => {
        ledger.configure(account, { ...policy, maxRequests: 4 }, NOW);
      }).toThrow("request.conflict");
      expect(database.readOne("SELECT created_at FROM marea_usage_accounts")?.created_at).toBe(NOW);
      expect(ledger.reserve(input())).toEqual({
        admitted: true,
        reservationId: "attempt:one",
        policy,
      });
      expect(ledger.reserve(input("attempt:other"))).toEqual({
        admitted: false,
        reason: "concurrency",
      });
      expect(ledger.totals(account)).toEqual({
        requests: 1,
        tokens: 20,
        costUnits: 50,
        inFlight: 1,
      });
      const evaluation = { ...account, purpose: "evaluation" as const };
      ledger.configure(evaluation, policy, NOW);
      expect(ledger.reserve({ ...input("attempt:evaluation"), ...evaluation }).admitted).toBe(true);
      expect(ledger.totals(evaluation)).toEqual({
        requests: 1,
        tokens: 20,
        costUnits: 50,
        inFlight: 1,
      });
      expect(ledger.totals({ ...account, runId: "run:b" }).requests).toBe(0);
    } finally {
      database.close();
    }
  });

  it("settles exact usage idempotently and charges each retry as another request", () => {
    const { database } = setup();
    try {
      const ledger = new SqliteUsageLedger(database);
      ledger.configure(account, policy, NOW);
      ledger.reserve(input());
      const usage = { inputTokens: 2, outputTokens: 3 };
      expect(ledger.settle("attempt:one", usage, NOW)).toBe("settled");
      expect(ledger.settle("attempt:one", usage, "2026-09-08T12:00:00.000Z")).toBe("settled");
      expect(database.readOne("SELECT settled_at FROM marea_usage_attempts")?.settled_at).toBe(NOW);
      for (const changed of [
        null,
        { inputTokens: 3, outputTokens: 3 },
        { inputTokens: 2, outputTokens: 4 },
      ])
        expect(() => ledger.settle("attempt:one", changed, NOW)).toThrow("request.conflict");
      expect(() => ledger.settle("attempt:absent", usage, NOW)).toThrow("request.conflict");
      expect(ledger.totals(account)).toEqual({
        requests: 1,
        tokens: 5,
        costUnits: 13,
        inFlight: 0,
      });
      expect(() => ledger.reserve(input())).toThrow();
      expect(() => ledger.reserve(input("attempt:same-logical-attempt"))).toThrow();
      for (const attempt of [2, 3]) {
        const reservationId = `attempt:${String(attempt)}`;
        expect(ledger.reserve({ ...input(reservationId), attempt }).admitted).toBe(true);
        ledger.settle(reservationId, { inputTokens: 0, outputTokens: 0 }, NOW);
      }
      expect(ledger.reserve({ ...input("attempt:four"), attempt: 4 })).toEqual({
        admitted: false,
        reason: "requests",
      });
      expect(ledger.totals(account)).toEqual({
        requests: 3,
        tokens: 5,
        costUnits: 13,
        inFlight: 0,
      });
    } finally {
      database.close();
    }
  });

  it("retains uncertain costs after cancellation and admits only within remaining token and cost budgets", () => {
    const { database } = setup();
    try {
      const ledger = new SqliteUsageLedger(database);
      ledger.configure(account, { ...policy, maxTokens: 20 }, NOW);
      ledger.reserve(input());
      expect(ledger.settle("attempt:one", null, NOW)).toBe("unknown");
      expect(ledger.settle("attempt:one", null, "2026-09-08T12:00:00.000Z")).toBe("unknown");
      expect(database.readOne("SELECT settled_at FROM marea_usage_attempts")?.settled_at).toBe(NOW);
      expect(ledger.totals(account)).toEqual({
        requests: 1,
        tokens: 20,
        costUnits: 50,
        inFlight: 0,
      });
      expect(ledger.reserve({ ...input("attempt:two"), attempt: 2 })).toEqual({
        admitted: false,
        reason: "tokens",
      });
      expect(ledger.settle("attempt:one", { inputTokens: 0, outputTokens: 0 }, NOW)).toBe(
        "settled",
      );
      const evaluation = { ...account, purpose: "evaluation" as const };
      ledger.configure(evaluation, { ...policy, maxCostUnits: 50 }, NOW);
      ledger.reserve({ ...input("attempt:evaluation"), ...evaluation });
      ledger.settle("attempt:evaluation", null, NOW);
      expect(
        ledger.reserve({ ...input("attempt:next-evaluation"), ...evaluation, attempt: 2 }),
      ).toEqual({ admitted: false, reason: "cost" });
    } finally {
      database.close();
    }
  });

  it("quarantines provider overages and rejects invalid settlement counters", () => {
    const { database } = setup();
    try {
      const ledger = new SqliteUsageLedger(database);
      for (const [runId, usage] of [
        ["run:a", { inputTokens: 11, outputTokens: 0 }],
        ["run:b", { inputTokens: 0, outputTokens: 11 }],
      ] as const) {
        const scope = { ...account, runId };
        ledger.configure(scope, policy, NOW);
        ledger.reserve({ ...input(runId), ...scope });
        const extra = { inputTokens: 0, outputTokens: 0, extra: true };
        expect(() => ledger.settle(runId, extra, NOW)).toThrow();
        for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
          expect(() =>
            ledger.settle(runId, { inputTokens: invalid, outputTokens: 0 }, NOW),
          ).toThrow();
          expect(() =>
            ledger.settle(runId, { inputTokens: 0, outputTokens: invalid }, NOW),
          ).toThrow();
        }
        expect(ledger.settle(runId, usage, NOW)).toBe("breached");
        expect(ledger.settle(runId, usage, "2026-09-08T12:00:00.000Z")).toBe("breached");
        expect(
          database.readOne("SELECT settled_at FROM marea_usage_attempts WHERE id = ?1", [runId])
            ?.settled_at,
        ).toBe(NOW);
        expect(ledger.settle(runId, usage, NOW)).toBe("breached");
        expect(ledger.reserve({ ...input(`next:${runId}`), ...scope, attempt: 2 })).toEqual({
          admitted: false,
          reason: "breached",
        });
        expect(ledger.totals(scope).tokens).toBe(11);
      }
    } finally {
      database.close();
    }
  });

  it("preserves reservations across process reopen and recovers only unfinished attempts without refunding them", () => {
    const directory = mkdtempSync(join(tmpdir(), "marea-usage-"));
    const path = join(directory, "teacher.sqlite");
    try {
      const { database } = setup(path);
      const ledger = new SqliteUsageLedger(database);
      ledger.configure(account, policy, NOW);
      ledger.reserve(input());
      database.close();
      const reopened = new NodeSqliteTestDatabase(path);
      try {
        const recovered = new SqliteUsageLedger(reopened);
        const later = "2026-09-08T12:00:00.000Z";
        expect(recovered.reserve({ ...input("attempt:two"), attempt: 2 }).admitted).toBe(false);
        recovered.recoverUnfinished(later);
        recovered.recoverUnfinished("2026-09-09T12:00:00.000Z");
        expect(
          reopened.readOne("SELECT state, settled_at FROM marea_usage_attempts"),
        ).toMatchObject({ state: "unknown", settled_at: later });
        expect(recovered.totals(account)).toEqual({
          requests: 1,
          tokens: 20,
          costUnits: 50,
          inFlight: 0,
        });
        expect(recovered.reserve({ ...input("attempt:two"), attempt: 2 }).admitted).toBe(true);
        recovered.settle("attempt:two", { inputTokens: 10, outputTokens: 10 }, later);
        recovered.recoverUnfinished("2026-09-09T12:00:00.000Z");
        expect(
          reopened.readOne(
            "SELECT state, settled_at FROM marea_usage_attempts WHERE id = 'attempt:two'",
          ),
        ).toMatchObject({ state: "settled", settled_at: later });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
