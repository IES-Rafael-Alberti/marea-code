import { educationalAccountRows } from "../platform/operations/retention/educational-retention.js";
import { it, expect } from "vitest";
import { fixture } from "./insights.fixture.js";
import { NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { inspectRun } from "../platform/operations/retention/retention-runs.js";
import { deleteRetentionContent } from "../platform/operations/retention/retention-content.js";
it("includes report dependencies in retention previews and invalidates them during exact deletion", () => {
  const f = fixture();
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
