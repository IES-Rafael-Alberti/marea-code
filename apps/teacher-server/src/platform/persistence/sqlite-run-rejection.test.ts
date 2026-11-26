import { AppendRunEventsRequestSchema, CanonicalRunEventSchema } from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { TeacherDomainError } from "../../identity/errors.js";
import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import { teachingInput } from "../../../test-support/teaching-fixture.js";
import {
  bundleSource,
  clock,
  newRun,
  seedTeachingDatabase,
  servicesFor,
  student,
  teacher,
} from "../../../test-support/teaching-integration.fixture.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

function request(sequence: number) {
  return AppendRunEventsRequestSchema.parse({
    kind: "run-events-append",
    protocolVersion: "0.1",
    requestId: "request:rejected",
    events: [
      CanonicalRunEventSchema.parse({
        eventType: "student-message",
        eventId: `event:rejected:${String(sequence)}`,
        content: "Hello",
        occurredAt: clock.now(),
        sequence,
      }),
    ],
  });
}

describe("operator log of refused run events", () => {
  let database: NodeSqliteTestDatabase;
  let services: ReturnType<typeof servicesFor>;
  let write: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    database = new NodeSqliteTestDatabase();
    seedTeachingDatabase(database);
    services = servicesFor(database, bundleSource());
    await services.teaching.save(teacher, teachingInput());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // An unexpected storage failure makes the database close itself.
    try {
      database.close();
    } catch {
      // Already closed.
    }
  });

  it("writes one stderr JSON line naming the run, the event types and the reason", () => {
    const opened = services.runs.open(student, newRun("rejected"));
    expect(() => services.runs.append(opened.lease.token, request(9))).toThrow("request.conflict");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({
        component: "run-events",
        event: "events-rejected",
        runId: opened.lease.runId,
        eventTypes: ["student-message"],
        sequences: [9],
        reason: "request.conflict",
      })}\n`,
    );
  });

  it("still refuses when the private sink fails", () => {
    const opened = services.runs.open(student, newRun("rejected-sink"));
    write.mockImplementation(() => {
      throw new Error("stderr closed");
    });
    expect(() => services.runs.append(opened.lease.token, request(9))).toThrow("request.conflict");
  });

  it.each([
    ["a refused lease", new TeacherDomainError("run.unavailable")],
    ["an unexpected failure", new Error("disk")],
    ["another domain refusal", new TeacherDomainError("auth.invalid")],
  ])("writes nothing for %s", (_name, failure) => {
    const opened = services.runs.open(student, newRun("rejected-other"));
    vi.spyOn(SqliteRunSessionRepository.prototype, "appendEvents").mockImplementation(() => {
      throw failure;
    });
    expect(() => services.runs.append(opened.lease.token, request(2))).toThrow(failure);
    expect(write).not.toHaveBeenCalled();
  });
});
