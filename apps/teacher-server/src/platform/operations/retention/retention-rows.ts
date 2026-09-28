import { createHash } from "node:crypto";

import type { SqliteRow } from "@marea/sqlite-storage";

import { canonicalJsonBytes } from "../canonical-encoder.js";

import type { ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import type { TargetRef } from "../schemas.js";
import { blocker, type RetentionBlocker } from "./retention-blockers.js";

/** A derived-row query selecting `rows` and `bytes` plus the columns whose change makes a preview stale. */
export type DerivedQuery = readonly [name: string, sql: string];

/** A query that returns a row exactly when the blocker applies; `?1` is the root id and `?2` is now. */
export type BlockerQuery = readonly [
  code: RetentionBlocker["code"],
  detailCode: string,
  sql: string,
];

export interface Measured {
  readonly rows: number;
  readonly bytes: number;
  /** A SHA-256 over every derived row, streamed so large histories stay within encoder limits. */
  readonly fingerprint: string;
}

/** SQLite drivers return integers as numbers or bigints; digests need one JSON-safe form. */
function plain(row: SqliteRow): SqliteRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}

export function measure(
  database: ReadOnlySqliteApplicationDatabase,
  queries: readonly DerivedQuery[],
  id: string,
): Measured {
  let rows = 0;
  let bytes = 0;
  const hash = createHash("sha256");
  for (const [name, sql] of queries)
    for (const row of database.readAll(sql, [id]).map(plain)) {
      rows += Number(row.rows);
      bytes += Number(row.bytes);
      hash.update(canonicalJsonBytes([name, row]));
    }
  return { rows, bytes, fingerprint: `sha256:${hash.digest("hex")}` };
}

export function blockersOf(
  database: ReadOnlySqliteApplicationDatabase,
  queries: readonly BlockerQuery[],
  node: TargetRef,
  id: string,
  now: string,
): readonly RetentionBlocker[] {
  return queries
    .filter(
      ([, , sql]) => database.readOne(sql, sql.includes("?2") ? [id, now] : [id]) !== undefined,
    )
    .map(([code, detailCode]) => blocker(code, node, detailCode));
}
