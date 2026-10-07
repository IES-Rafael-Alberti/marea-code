import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { requiredRow, rowInteger, rowNullableText, rowText } from "./row-parser.boundary.js";
export interface QueuedTrace {
  readonly runId: string;
  readonly through: number;
  readonly attempts: number;
}
export class SqliteTraceQueue {
  constructor(readonly database: SqliteApplicationDatabase) {}
  configure(epoch: string): void {
    this.database.transaction(() => {
      const state = this.database.readOne("SELECT epoch FROM marea_trace_state WHERE id = 1");
      if (state !== undefined && rowText(state, "epoch") === epoch) return;
      this.database.execute("DELETE FROM marea_trace_outbox");
      this.database.execute("DELETE FROM marea_trace_progress");
      this.database
        .execute(`INSERT INTO marea_trace_progress SELECT runs.id, COALESCE(MAX(events.sequence),0)
        FROM marea_runs runs LEFT JOIN marea_run_events events ON events.run_id=runs.id GROUP BY runs.id`);
      this.database.execute(
        `INSERT INTO marea_trace_state(id,epoch) VALUES(1,?1)
        ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch`,
        [epoch],
      );
    });
  }
  capture(now: string): void {
    this.database.transaction(() => {
      const rows = this.database
        .readAll(`SELECT events.run_id, events.sequence FROM marea_run_events events
        LEFT JOIN marea_trace_progress progress ON progress.run_id = events.run_id
        WHERE events.sequence > COALESCE(progress.through_sequence,0) AND events.event_type IN ('turn-ended','turn-failed')
        ORDER BY events.rowid LIMIT 100`);
      let count = rowInteger(
        requiredRow(this.database.readOne("SELECT COUNT(*) AS count FROM marea_trace_outbox")),
        "count",
      );
      for (const row of rows) {
        const run = rowText(row, "run_id");
        const through = rowInteger(row, "sequence");
        if (count < 1000) {
          this.database.execute(
            "INSERT INTO marea_trace_outbox(run_id,through_sequence,next_at) VALUES(?1,?2,?3)",
            [run, through, now],
          );
          count++;
        } else this.database.execute("UPDATE marea_trace_state SET dropped=dropped+1 WHERE id=1");
        this.database.execute(
          `INSERT INTO marea_trace_progress VALUES(?1,?2)
          ON CONFLICT(run_id) DO UPDATE SET through_sequence=excluded.through_sequence`,
          [run, through],
        );
      }
    });
  }
  next(now: string): QueuedTrace | undefined {
    const row = this.database.readOne(
      "SELECT * FROM marea_trace_outbox WHERE attempts < 8 AND next_at <= ?1 ORDER BY next_at,run_id,through_sequence LIMIT 1",
      [now],
    );
    return row === undefined
      ? undefined
      : {
          runId: rowText(row, "run_id"),
          through: rowInteger(row, "through_sequence"),
          attempts: rowInteger(row, "attempts"),
        };
  }
  success(item: QueuedTrace, now: string): void {
    this.database.transaction(() => {
      this.database.execute(
        "DELETE FROM marea_trace_outbox WHERE run_id=?1 AND through_sequence=?2",
        [item.runId, item.through],
      );
      this.database.execute("UPDATE marea_trace_state SET sent=sent+1,last_sent_at=?1 WHERE id=1", [
        now,
      ]);
    });
  }
  failure(item: QueuedTrace, now: string, code: string): void {
    const attempts = code === "payload-too-large" ? 8 : item.attempts + 1;
    const next = new Date(Date.parse(now) + Math.min(300_000, 1000 * 2 ** attempts)).toISOString();
    this.database.execute(
      "UPDATE marea_trace_outbox SET attempts=?3,next_at=?4,last_error=?5 WHERE run_id=?1 AND through_sequence=?2",
      [item.runId, item.through, attempts, next, code],
    );
  }
  retry(now: string) {
    this.database.execute("UPDATE marea_trace_outbox SET attempts=0,next_at=?1,last_error=NULL", [
      now,
    ]);
  }
  status() {
    const count = requiredRow(
      this.database.readOne(
        "SELECT COUNT(*) AS pending, COALESCE(SUM(attempts >= 8),0) AS failed FROM marea_trace_outbox",
      ),
    );
    const state = this.database.readOne(
      "SELECT sent,dropped,last_sent_at FROM marea_trace_state WHERE id=1",
    );
    return {
      pending: rowInteger(count, "pending") - rowInteger(count, "failed"),
      failed: rowInteger(count, "failed"),
      sent: state === undefined ? 0 : rowInteger(state, "sent"),
      dropped: state === undefined ? 0 : rowInteger(state, "dropped"),
      lastSentAt: state === undefined ? null : rowNullableText(state, "last_sent_at"),
    };
  }
}
