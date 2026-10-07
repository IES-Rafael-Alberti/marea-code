import { expect, it } from "vitest";
import {
  addTraceEvent,
  completeTurn,
  observabilityFixture,
} from "../../observability/observability.fixture.js";
import { NOW } from "../../../test-support/history-fixture.js";
import { removeRemainingRetentionContent } from "../operations/retention/retention-content.js";
import { observabilityRunRows } from "../operations/retention/observability-retention.js";
import { SqliteTraceQueue } from "./sqlite-trace-queue.js";
import { requiredRow } from "./row-parser.boundary.js";

it("bounds retained references, records drops and advances the cursor without replaying history", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    for (let i = 0; i < 1000; i++)
      f.database.execute(
        "INSERT INTO marea_trace_outbox(run_id,through_sequence,next_at) VALUES('run:a',?1,?2)",
        [i + 100, NOW],
      );
    completeTurn(f.database);
    f.runtime.queue.capture(NOW);
    expect(f.runtime.queue.status()).toMatchObject({ pending: 1000, dropped: 1 });
    f.runtime.queue.capture(NOW);
    expect(f.runtime.queue.status().dropped).toBe(1);
    expect(
      f.database.readOne("SELECT through_sequence FROM marea_trace_progress WHERE run_id='run:a'"),
    ).toEqual({ through_sequence: 7n });
    f.database.execute("DELETE FROM marea_trace_outbox");
    addTraceEvent(f.database, 8, {
      eventType: "turn-failed",
      messageId: "message:failed",
      category: "provider",
      retryable: true,
    });
    f.runtime.queue.capture(NOW);
    expect(f.runtime.queue.next(NOW)).toEqual({ runId: "run:a", through: 8, attempts: 0 });
    for (let i = 0; i < 9; i++)
      f.runtime.queue.failure({ runId: "run:a", through: 8, attempts: i }, NOW, "unavailable");
    expect(f.runtime.queue.status()).toMatchObject({ pending: 0, failed: 1 });
    expect(f.database.readOne("SELECT next_at FROM marea_trace_outbox")).toEqual({
      next_at: "2026-09-07T12:05:00.000Z",
    });
    expect(f.runtime.queue.next("2026-09-08T00:00:00.000Z")).toBeUndefined();
    f.runtime.queue.retry(NOW);
    expect(f.runtime.queue.next(NOW)).toMatchObject({ attempts: 0 });
  } finally {
    f.database.close();
  }
});
it("retention removes references and progress with a session; recreated workers see no pending content", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    completeTurn(f.database, 3, "run:b");
    f.runtime.queue.capture(NOW);
    expect(observabilityRunRows(f.database)).toHaveLength(2);
    const before = f.database.readAll("SELECT * FROM marea_trace_outbox");
    expect(before).toHaveLength(1);
    expect(
      removeRemainingRetentionContent(f.database, {
        runIds: ["run:b"],
        snapshotIds: [],
        accountIds: [],
      }),
    ).toBeGreaterThan(7);
    expect(new SqliteTraceQueue(f.database).next(NOW)).toBeUndefined();
    expect(f.database.readAll("SELECT * FROM marea_trace_progress WHERE run_id='run:b'")).toEqual(
      [],
    );
    expect(() => requiredRow(undefined)).toThrow("Stored teacher data is invalid.");
    expect(requiredRow({ value: "ok" })).toEqual({ value: "ok" });
  } finally {
    f.database.close();
  }
});

it("accepts the last queue slot and counts overflow within the same capture batch", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    for (let i = 0; i < 999; i++)
      f.database.execute(
        "INSERT INTO marea_trace_outbox(run_id,through_sequence,next_at) VALUES('run:a',?1,?2)",
        [i + 100, NOW],
      );
    completeTurn(f.database, 3);
    completeTurn(f.database, 8);
    f.runtime.queue.capture(NOW);
    expect(f.runtime.queue.status()).toMatchObject({ pending: 1000, dropped: 1 });
    expect(
      f.database.readOne(
        "SELECT through_sequence FROM marea_trace_outbox WHERE through_sequence=7",
      ),
    ).toEqual({ through_sequence: 7n });
  } finally {
    f.database.close();
  }
});
