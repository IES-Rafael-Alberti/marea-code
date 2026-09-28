import { inspectAccount } from "../platform/operations/retention/retention-accounts.js";
import { expect, it } from "vitest";
import { profileHarness, write } from "./profile.fixture.js";
import { profileRetentionRows } from "../platform/operations/retention/profile-retention.js";
import { measure } from "../platform/operations/retention/retention-rows.js";
import { DashboardProfileError } from "./contracts.js";
it("includes profile bytes and revision changes in retention fingerprints", () => {
  const h = profileHarness();
  try {
    h.execute("save", write());
    const queries = profileRetentionRows(h.database);
    expect(queries[0]?.[0]).toBe("dashboardProfiles");
    const before = measure(h.database, queries, "teacher-1");
    expect(before.rows).toBe(1);
    expect(before.bytes).toBe(
      new TextEncoder().encode(JSON.stringify(h.read().personal.value)).byteLength,
    );
    h.database.execute("UPDATE marea_dashboard_profiles SET revision = 'new-revision'");
    expect(measure(h.database, queries, "teacher-1").fingerprint).not.toBe(before.fingerprint);
  } finally {
    h.database.close();
  }
});
it("uses a stable safe profile failure diagnostic", () => {
  expect(new DashboardProfileError(409).message).toBe("Dashboard profile operation unavailable.");
});
it("includes profiles in the reference-aware account inventory", () => {
  const h = profileHarness();
  try {
    const before = inspectAccount(h.database, "teacher-1", "2026-09-22T12:00:00Z");
    h.execute("save", write());
    const after = inspectAccount(h.database, "teacher-1", "2026-09-22T12:00:00Z");
    expect(after?.rows).toBe((before?.rows ?? 0) + 1);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  } finally {
    h.database.close();
  }
});
