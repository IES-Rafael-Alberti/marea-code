import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import { TeacherDomainError } from "../../identity/errors.js";
import type {
  ReserveUsageInput,
  UsageAccount,
  UsageLedger,
  UsageReservation,
  UsageSettlement,
} from "../../model-gateway/usage-ledger.js";
import {
  admissionDenial,
  chargeForUsage,
  reservedCharge,
  TokenUsageSchema,
  UsagePolicySchema,
  type TokenUsage,
  type UsagePolicy,
  type UsageTotals,
} from "../../model-gateway/usage-policy.js";
import { rowInteger, rowJson, rowText } from "./row-parser.boundary.js";

export class SqliteUsageLedger implements UsageLedger {
  public constructor(
    private readonly database: Pick<
      SqliteApplicationDatabase,
      "execute" | "readOne" | "transaction"
    >,
  ) {}

  public configure(account: UsageAccount, policy: UsagePolicy, now: string): void {
    const serialized = JSON.stringify(UsagePolicySchema.parse(policy));
    this.database.transaction(() => {
      const previous = this.database.readOne(
        "SELECT policy_json FROM marea_usage_accounts WHERE run_id = ?1 AND purpose = ?2",
        [account.runId, account.purpose],
      );
      if (previous !== undefined) {
        if (rowText(previous, "policy_json") !== serialized)
          throw new TeacherDomainError("request.conflict");
        return;
      }
      this.database.execute(
        `INSERT INTO marea_usage_accounts (run_id, purpose, policy_json, created_at)
          VALUES (?1, ?2, ?3, ?4)`,
        [account.runId, account.purpose, serialized, now],
      );
    });
  }

  public reserve(input: ReserveUsageInput): UsageReservation {
    return this.database.transaction(() => {
      const account = this.database.readOne(
        "SELECT policy_json FROM marea_usage_accounts WHERE run_id = ?1 AND purpose = ?2",
        [input.runId, input.purpose],
      );
      if (account === undefined) return { admitted: false, reason: "unconfigured" };
      if (
        this.database.readOne(
          "SELECT id FROM marea_usage_attempts WHERE run_id = ?1 AND purpose = ?2 AND state = 'breached' LIMIT 1",
          [input.runId, input.purpose],
        ) !== undefined
      )
        return { admitted: false, reason: "breached" };
      const policy = rowJson(account, "policy_json", UsagePolicySchema);
      const reason = admissionDenial(policy, this.totals(input));
      if (reason !== null) return { admitted: false, reason };
      const charge = reservedCharge(policy);
      this.database.execute(
        `INSERT INTO marea_usage_attempts
          (id, run_id, purpose, request_id, attempt, state, input_tokens, output_tokens, cost_units, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, 'reserved', ?6, ?7, ?8, ?9)`,
        [
          input.reservationId,
          input.runId,
          input.purpose,
          input.requestId,
          input.attempt,
          charge.inputTokens,
          charge.outputTokens,
          charge.costUnits,
          input.now,
        ],
      );
      return { admitted: true, reservationId: input.reservationId, policy };
    });
  }

  public totals(account: UsageAccount): UsageTotals {
    const row = this.database.readOne(
      `SELECT COUNT(*) AS requests, SUM(input_tokens + output_tokens) AS tokens,
        SUM(cost_units) AS cost_units,
        SUM(CASE WHEN state = 'reserved' THEN 1 ELSE 0 END) AS in_flight
        FROM marea_usage_attempts WHERE run_id = ?1 AND purpose = ?2 GROUP BY run_id, purpose`,
      [account.runId, account.purpose],
    );
    if (row === undefined) return { requests: 0, tokens: 0, costUnits: 0, inFlight: 0 };
    return {
      requests: rowInteger(row, "requests"),
      tokens: rowInteger(row, "tokens"),
      costUnits: rowInteger(row, "cost_units"),
      inFlight: rowInteger(row, "in_flight"),
    };
  }

  public settle(reservationId: string, usage: TokenUsage | null, now: string): UsageSettlement {
    if (usage !== null) TokenUsageSchema.parse(usage);
    return this.database.transaction(() => {
      const row = this.database.readOne(
        `SELECT attempts.*, accounts.policy_json FROM marea_usage_attempts attempts
          JOIN marea_usage_accounts accounts USING (run_id, purpose) WHERE attempts.id = ?1`,
        [reservationId],
      );
      if (row === undefined) throw new TeacherDomainError("request.conflict");
      const state = rowText(row, "state");
      if (state === "settled" || state === "breached") {
        if (
          usage?.inputTokens !== rowInteger(row, "input_tokens") ||
          usage.outputTokens !== rowInteger(row, "output_tokens")
        )
          throw new TeacherDomainError("request.conflict");
        return state;
      }
      if (usage === null) {
        this.database.execute(
          "UPDATE marea_usage_attempts SET state = 'unknown', settled_at = COALESCE(settled_at, ?2) WHERE id = ?1",
          [reservationId, now],
        );
        return "unknown";
      }
      return this.settleKnown(row, usage, now);
    });
  }

  public recoverUnfinished(now: string): void {
    this.database.execute(
      "UPDATE marea_usage_attempts SET state = 'unknown', settled_at = ?1 WHERE state = 'reserved'",
      [now],
    );
  }

  public consumeToolCall(reservationId: string, callId: string): boolean {
    return this.database.transaction(() => {
      const row = this.database.readOne(
        `SELECT attempts.run_id, attempts.purpose, accounts.policy_json
          FROM marea_usage_attempts attempts JOIN marea_usage_accounts accounts USING (run_id, purpose)
          WHERE attempts.id = ?1 AND attempts.state = 'reserved'`,
        [reservationId],
      );
      if (row === undefined) throw new TeacherDomainError("request.conflict");
      if (
        this.database.readOne(
          "SELECT call_id FROM marea_usage_tool_calls WHERE reservation_id = ?1 AND call_id = ?2",
          [reservationId, callId],
        ) !== undefined
      )
        return true;
      const total = this.database.readOne(
        `SELECT COUNT(*) AS total FROM marea_usage_tool_calls calls
          JOIN marea_usage_attempts attempts ON attempts.id = calls.reservation_id
          WHERE attempts.run_id = ?1 AND attempts.purpose = ?2 GROUP BY attempts.run_id, attempts.purpose`,
        [rowText(row, "run_id"), rowText(row, "purpose")],
      );
      const count = total === undefined ? 0 : rowInteger(total, "total");
      const policy = rowJson(row, "policy_json", UsagePolicySchema);
      if (policy.unlimited !== true && count >= policy.maxToolCalls) return false;
      this.database.execute(
        "INSERT INTO marea_usage_tool_calls (reservation_id, call_id) VALUES (?1, ?2)",
        [reservationId, callId],
      );
      return true;
    });
  }

  private settleKnown(row: SqliteRow, usage: TokenUsage, now: string): UsageSettlement {
    const policy = rowJson(row, "policy_json", UsagePolicySchema);
    const charge = chargeForUsage(policy, usage);
    const state =
      policy.unlimited !== true &&
      (usage.inputTokens > policy.maxInputTokens || usage.outputTokens > policy.maxOutputTokens)
        ? "breached"
        : "settled";
    this.database.execute(
      `UPDATE marea_usage_attempts SET state = ?2, input_tokens = ?3, output_tokens = ?4,
        cost_units = ?5, settled_at = ?6 WHERE id = ?1`,
      [rowText(row, "id"), state, charge.inputTokens, charge.outputTokens, charge.costUnits, now],
    );
    return state;
  }
}
