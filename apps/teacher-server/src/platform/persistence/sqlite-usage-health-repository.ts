import {
  UsageCostSchema,
  UsageEntrySchema,
  type UsageEntry,
  type UsageQuery,
} from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";
import { chargeForUsage, UsagePolicySchema } from "../../model-gateway/usage-policy.js";
import type { UsageHealthRepository } from "../../usage-health/service.js";
import { rowInteger, rowNullableText, rowText } from "./row-parser.boundary.js";
import { SqliteTeachingConfigurationRepository } from "./sqlite-teaching-configuration-repository.js";

/** Only policy units and validated ledger charges leave this adapter, never route configuration. */
function cost(row: SqliteRow) {
  try {
    const policy = UsagePolicySchema.parse(JSON.parse(rowText(row, "policy_json")));
    const charge = chargeForUsage(policy, {
      inputTokens: rowInteger(row, "input_tokens"),
      outputTokens: rowInteger(row, "output_tokens"),
    });
    if (charge.costUnits !== rowInteger(row, "cost_units"))
      return { status: "unavailable" } as const;
    return UsageCostSchema.parse({
      status: "priced",
      unit: policy.costUnit,
      units: charge.costUnits,
    });
  } catch {
    return { status: "unavailable" } as const;
  }
}
function entry(row: SqliteRow): UsageEntry {
  const state = rowText(row, "state");
  return UsageEntrySchema.parse({
    attemptId: rowText(row, "id"),
    purpose: rowText(row, "purpose"),
    state,
    createdAt: rowText(row, "created_at"),
    settledAt: rowNullableText(row, "settled_at"),
    tokenBasis: state === "settled" || state === "breached" ? "reported" : "reservation",
    inputTokens: rowInteger(row, "input_tokens"),
    outputTokens: rowInteger(row, "output_tokens"),
    cost: cost(row),
  });
}
export class SqliteUsageHealthRepository implements UsageHealthRepository {
  constructor(private readonly database: SqliteApplicationDatabase) {}
  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }
  requireTeacherClass(teacherId: string, classId: string): void {
    new SqliteTeachingConfigurationRepository(this.database).requireTeacherClass(
      teacherId,
      classId,
    );
  }
  page(query: UsageQuery): readonly UsageEntry[] {
    return this.database
      .readAll(
        `SELECT attempts.*, accounts.policy_json
      FROM marea_usage_attempts attempts JOIN marea_runs runs ON runs.id = attempts.run_id
      LEFT JOIN marea_usage_accounts accounts ON accounts.run_id = attempts.run_id AND accounts.purpose = attempts.purpose
      WHERE runs.class_id = ?1 AND julianday(attempts.created_at) >= julianday(?2)
        AND julianday(attempts.created_at) < julianday(?3) AND attempts.id > ?4
      ORDER BY attempts.id COLLATE BINARY LIMIT ?5`,
        [query.classId, query.from, query.until, query.afterAttemptId ?? "", query.limit + 1],
      )
      .map(entry);
  }
  lastObservedAt(classId: string): string | null {
    const row = this.database.readOne(
      `SELECT COALESCE(attempts.settled_at, attempts.created_at) AS observed_at
      FROM marea_usage_attempts attempts JOIN marea_runs runs ON runs.id = attempts.run_id
      WHERE runs.class_id = ?1 ORDER BY julianday(COALESCE(attempts.settled_at, attempts.created_at)) DESC LIMIT 1`,
      [classId],
    );
    return row === undefined ? null : rowText(row, "observed_at");
  }
}
