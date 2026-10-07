import { expect, it } from "vitest";
import { observabilityFixture, completeTurn } from "./observability.fixture.js";
import { NOW } from "../../test-support/history-fixture.js";
import { inspectRun } from "../platform/operations/retention/retention-runs.js";
import { deleteRetentionContent } from "../platform/operations/retention/retention-content.js";

it("includes delivery references in reviewed deletion counts and invalidates a review when delivery changes", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    completeTurn(f.database, 3, "run:b");
    const before = inspectRun(f.database, "run:b", NOW);
    if (!before) throw new Error("fixture");
    f.runtime.queue.capture(NOW);
    const queued = inspectRun(f.database, "run:b", NOW);
    if (!queued) throw new Error("fixture");
    expect(queued.rows).toBe(before.rows + 1);
    expect(queued.fingerprint).not.toBe(before.fingerprint);
    expect(queued).toMatchSnapshot("retention review with delivery references");
    f.runtime.queue.failure({ runId: "run:b", through: 7, attempts: 0 }, NOW, "unavailable");
    const failed = inspectRun(f.database, "run:b", NOW);
    expect(failed?.rows).toBe(queued.rows);
    expect(failed?.fingerprint).not.toBe(queued.fingerprint);
    deleteRetentionContent(
      f.database,
      { runIds: ["run:b"], snapshotIds: [], accountIds: [], backupNames: [] },
      queued.rows,
    );
    expect(inspectRun(f.database, "run:b", NOW)).toBeUndefined();
    expect(f.database.readAll("SELECT * FROM marea_trace_outbox WHERE run_id='run:b'")).toEqual([]);
    expect(f.database.readAll("SELECT * FROM marea_trace_progress WHERE run_id='run:b'")).toEqual(
      [],
    );
  } finally {
    f.database.close();
  }
});
