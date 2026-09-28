import { describe, expect, it } from "vitest";

import { DatabaseFake } from "../../../test-support/database-fake.js";
import { activeLeaseRow } from "./sqlite-run-repository.test-support.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

describe("SQLite run lease repository authorization", () => {
  it("resolves internal run, student, and private route from only an active lease hash", () => {
    const database = new DatabaseFake();
    database.oneRows.push(activeLeaseRow());
    expect(
      new SqliteRunSessionRepository(database).authorizeLease({
        leaseTokenHash: "digest:lease",
        now: "2026-09-03T10:04:00.000Z",
      }),
    ).toEqual({
      providerRoute: { model: "model", providerId: "openrouter" },
      runId: "run:1",
      studentId: "user:alice",
    });
    expect(database.reads[0]?.parameters).toEqual(["digest:lease", "2026-09-03T10:04:00.000Z"]);
    expect(database.reads[0]?.sql).toContain("provider_route_json");
  });

  it("rejects unavailable leases and malformed private route storage", () => {
    const unavailableDatabase = new DatabaseFake();
    unavailableDatabase.oneRows.push(undefined);
    expect(() =>
      new SqliteRunSessionRepository(unavailableDatabase).authorizeLease({
        leaseTokenHash: "digest:missing",
        now: "now",
      }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));

    const malformedDatabase = new DatabaseFake();
    malformedDatabase.oneRows.push({
      ...activeLeaseRow(),
      provider_route_json: JSON.stringify({ model: "model", providerId: "openrouter", secret: 1 }),
    });
    expect(() =>
      new SqliteRunSessionRepository(malformedDatabase).authorizeLease({
        leaseTokenHash: "digest:lease",
        now: "now",
      }),
    ).toThrow();
  });
});
