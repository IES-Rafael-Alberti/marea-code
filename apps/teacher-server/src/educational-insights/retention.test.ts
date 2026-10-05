import {
  educationalAccountRows,
  educationalRunRows,
} from "../platform/operations/retention/educational-retention.js";
import { it, expect } from "vitest";
import { fixture } from "./insights.fixture.js";
import { NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { inspectRun } from "../platform/operations/retention/retention-runs.js";
import { inspectAccount } from "../platform/operations/retention/retention-accounts.js";
import { capture, enabled, targetOf } from "./progress.fixture.js";
import { deleteRetentionContent } from "../platform/operations/retention/retention-content.js";
it("includes report dependencies in retention previews and invalidates them during exact deletion", () => {
  const f = fixture();
  expect(educationalRunRows(f.database).map(([name]) => name)).toEqual([
    "learningHistory",
    "classReportSources",
  ]);
  const request = f.query({
    kind: "generate",
    from: "2026-01-01T00:00:00.000Z",
    to: NOW,
    locale: "es",
  });
  if (request.kind !== "generate") throw new Error("request");
  const before = inspectRun(f.database, "run:b", NOW);
  if (before === undefined) throw new Error("run");
  const report = f.service.reports.generate(teacher, request);
  const after = inspectRun(f.database, "run:b", NOW);
  if (after === undefined) throw new Error("run");
  expect(after.rows).toBe(before.rows + 1);
  expect(after.fingerprint).not.toBe(before.fingerprint);
  deleteRetentionContent(
    f.database,
    { runIds: ["run:b"], snapshotIds: [], accountIds: [], backupNames: [] },
    after.rows,
  );
  expect(f.service.reports.read(report.id, "class:one").state).toBe("invalidated");
  expect(f.database.readOne("SELECT id FROM marea_runs WHERE id = 'run:b'")).toBeUndefined();
});

it("includes learning progress and manual history in account retention", () => {
  const f = fixture();
  expect(educationalAccountRows(f.database).map(([name]) => name)).toEqual([
    "learningProgress",
    "learningManualHistory",
  ]);
});

it("deletes reviewed progress and manual history with the account using the exact preview count", () => {
  const f = fixture();
  enabled(f);
  const key = targetOf(capture(f)).key;
  f.progress.adjust(
    "class:one",
    "s1",
    [key],
    2,
    "Reviewed practical work",
    f.progress.read("class:one", "s1").revision,
    teacher.userId,
    NOW,
  );
  expect(f.database.readAll("SELECT 1 FROM marea_learning_progress")).toHaveLength(1);
  expect(
    f.database.readAll("SELECT 1 FROM marea_learning_history WHERE run_id IS NULL"),
  ).toHaveLength(1);
  const account = inspectAccount(f.database, "s1", NOW);
  if (account === undefined) throw new Error("account");
  const runRows = account.runIds.map((id) => {
    const run = inspectRun(f.database, id, NOW);
    if (run === undefined) throw new Error("run");
    return run.rows;
  });
  deleteRetentionContent(
    f.database,
    { runIds: account.runIds, snapshotIds: [], accountIds: ["s1"], backupNames: [] },
    account.rows + runRows.reduce((sum, rows) => sum + rows, 0),
  );
  expect(f.database.readOne("SELECT 1 FROM marea_learning_progress")).toBeUndefined();
  expect(f.database.readOne("SELECT 1 FROM marea_learning_history")).toBeUndefined();
  expect(f.database.readOne("SELECT 1 FROM marea_users WHERE id = 's1'")).toBeUndefined();
  expect(f.database.readOne("SELECT 1 FROM marea_users WHERE id = 's2'")).toBeDefined();
});
