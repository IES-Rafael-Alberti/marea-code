import { SessionHistoryQuerySchema } from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import { teachingInput } from "../../../test-support/teaching-fixture.js";
import {
  bundleSource,
  newRun,
  seedTeachingDatabase,
  servicesFor,
  student,
  teacher,
} from "../../../test-support/teaching-integration.fixture.js";
import { HistoryService } from "../../sessions/history-service.js";
import { SqliteHistoryRepository } from "./sqlite-history-repository.js";

const query = SessionHistoryQuerySchema.parse({
  kind: "session-history-query",
  protocolVersion: "0.1",
  requestId: "request:versions",
  limit: 10,
});

function mismatches(database: NodeSqliteTestDatabase, serverVersion: string | undefined) {
  const history = new HistoryService(new SqliteHistoryRepository(database, serverVersion));
  return history.listClassSessions(teacher, query).runs.map((run) => ({
    runId: run.runId,
    versionMismatch: run.versionMismatch,
  }));
}

describe("client version of each run on the teacher dashboard", () => {
  let database: NodeSqliteTestDatabase;
  let services: ReturnType<typeof servicesFor>;

  beforeEach(async () => {
    database = new NodeSqliteTestDatabase();
    seedTeachingDatabase(database);
    services = servicesFor(database, bundleSource());
    await services.teaching.save(teacher, teachingInput());
  });
  afterEach(() => {
    database.close();
  });

  it.each(["0.1.0", "0.3.0", "0.2.0-preview.1"])(
    "marks a session whose client %s differs from the server 0.2.0",
    (clientVersion) => {
      const opened = services.runs.open(student, { ...newRun("older"), clientVersion });
      expect(mismatches(database, "0.2.0")).toEqual([
        { runId: opened.lease.runId, versionMismatch: { clientVersion, serverVersion: "0.2.0" } },
      ]);
    },
  );

  it("does not mark a session with the same version, without a server version or never recorded", () => {
    const same = services.runs.open(student, { ...newRun("same"), clientVersion: "0.2.0" });
    expect(mismatches(database, "0.2.0")).toEqual([
      { runId: same.lease.runId, versionMismatch: undefined },
    ]);
    const other = services.runs.open(student, { ...newRun("other"), clientVersion: "0.1.0" });
    expect(mismatches(database, undefined).map((run) => run.versionMismatch)).toEqual([
      undefined,
      undefined,
    ]);
    database.execute("DELETE FROM marea_metadata WHERE key = ?1", [
      `run-client-version:${other.lease.runId}`,
    ]);
    expect(mismatches(database, "0.2.0").map((run) => run.versionMismatch)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("follows the client that resumes the session and never reaches the student's history", () => {
    const first = services.runs.open(student, { ...newRun("resume"), clientVersion: "0.1.0" });
    expect(mismatches(database, "0.2.0")[0]?.versionMismatch?.clientVersion).toBe("0.1.0");
    services.runs.open(student, {
      ...newRun("resume-again"),
      clientVersion: "0.2.0",
      runId: first.lease.runId,
      intent: { kind: "resume" },
    });
    expect(mismatches(database, "0.2.0")).toEqual([
      { runId: first.lease.runId, versionMismatch: undefined },
    ]);
    services.runs.open(student, {
      ...newRun("resume-third"),
      clientVersion: "0.3.0",
      runId: first.lease.runId,
      intent: { kind: "resume" },
    });
    const history = new HistoryService(new SqliteHistoryRepository(database, "0.2.0"));
    expect(JSON.stringify(history.listSessions(student, query))).not.toContain("0.3.0");
    expect(mismatches(database, "0.2.0")[0]?.versionMismatch?.clientVersion).toBe("0.3.0");
  });
});
