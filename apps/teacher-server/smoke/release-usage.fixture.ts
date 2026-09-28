import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { SqliteUsageLedger } from "../src/platform/persistence/sqlite-usage-ledger.js";
import { USAGE_POLICY } from "../test-support/usage-fixture.js";

/**
 * Synthetic priced ledger rows for the release session: 27 settled attempts and one open
 * reservation from the last minute, so a 25-row page has a second page and the ledger is fresh.
 */
export function seedReleaseUsage(database: SqliteApplicationDatabase, now = Date.now()) {
  const ledger = new SqliteUsageLedger(database);
  const account = { runId: "run:release", purpose: "tutoring" as const };
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  ledger.configure(
    account,
    { ...USAGE_POLICY, maxRequests: 100, maxTokens: 100_000, maxCostUnits: 1_000_000 },
    at(60),
  );
  for (let attempt = 1; attempt <= 28; attempt++) {
    const reservationId = `attempt:release-${String(attempt).padStart(2, "0")}`;
    const reserved = ledger.reserve({
      ...account,
      reservationId,
      requestId: `request:release-${String(attempt)}`,
      attempt: 1,
      now: at(60 - attempt),
    });
    if (!reserved.admitted) throw new Error(`Synthetic reservation refused: ${reserved.reason}`);
    if (attempt < 28)
      ledger.settle(
        reservationId,
        { inputTokens: 1 + (attempt % 9), outputTokens: 2 },
        at(59 - attempt),
      );
  }
}
