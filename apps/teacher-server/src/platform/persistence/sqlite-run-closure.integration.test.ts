import { CanonicalRunEventSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { TeacherDomainError } from "../../identity/errors.js";
import { CLOSURE_NOW, CLOSURE_OPENED, closureClassroom } from "./run-closure.fixture.js";
import { SqliteEvaluationRepository } from "./sqlite-evaluation-repository.js";

const IDLE_BEFORE = "2026-09-12T11:00:00.000Z";
const CAP_BEFORE = "2026-09-12T04:00:00.000Z";

function abandoned(c: ReturnType<typeof closureClassroom>, overrides = {}) {
  return c.closures.closeAbandoned({
    createEventId: c.createEventId,
    idleBefore: IDLE_BEFORE,
    now: CLOSURE_NOW,
    sessionOpenedBefore: CAP_BEFORE,
    ...overrides,
  });
}

describe("closing abandoned runs", () => {
  it("closes a run with no connection for an hour as session-expired, with its closing event", () => {
    const c = closureClassroom();
    const runId = c.open("user:alice");
    c.touch(runId, "2026-09-12T10:59:59.999Z");

    expect(abandoned(c)).toBe(1);

    expect(c.run(runId)).toEqual({
      state: "closed",
      closed_at: CLOSURE_NOW,
      close_reason: "session-expired",
      closed_by: null,
    });
    const closing = c.events(runId).at(-1);
    expect(closing).toMatchObject({ sequence: 2n, event_type: "run-closed" });
    expect(JSON.parse(String(closing?.payload_json))).toEqual({
      eventId: "event:closure:1",
      eventType: "run-closed",
      occurredAt: CLOSURE_NOW,
      reason: "session-expired",
      sequence: 2,
    });
    expect(
      c.f.database.readAll("SELECT run_id FROM marea_active_runs WHERE run_id = ?1", [runId]),
    ).toEqual([]);
    expect(abandoned(c)).toBe(0);
  });

  it("keeps a run whose last activity is exactly an hour old, a run with recent activity and a live lease", () => {
    const c = closureClassroom();
    const boundary = c.open("user:alice");
    c.touch(boundary, IDLE_BEFORE);
    const recent = c.open("user:bob");
    c.touch(recent, "2026-09-12T11:59:00.000Z");
    const leased = c.open("user:cara");
    c.touch(leased, "2026-09-12T08:00:00.000Z");
    c.expireLeases(leased, "2026-09-12T12:00:00.001Z");

    expect(abandoned(c)).toBe(0);
    for (const runId of [boundary, recent, leased]) expect(c.run(runId)?.state).toBe("active");

    // The lease lapses at the instant it expires, and a revoked lease never counts.
    c.expireLeases(leased, CLOSURE_NOW);
    expect(abandoned(c)).toBe(1);
    expect(c.run(leased)?.state).toBe("closed");
    expect(c.run(boundary)?.state).toBe("active");

    c.f.database.execute(
      "UPDATE marea_run_leases SET expires_at = '2026-09-12T13:00:00.000Z', revoked_at = ?1 WHERE run_id = ?2",
      [CLOSURE_OPENED, boundary],
    );
    c.touch(boundary, "2026-09-12T10:00:00.000Z");
    expect(abandoned(c)).toBe(1);
    expect(c.run(boundary)?.state).toBe("closed");
    expect(c.run(recent)?.state).toBe("active");
  });

  it("closes a run that outlived the sign-in cap only without a live session or lease", () => {
    const c = closureClassroom();
    const old = c.open("user:alice", "class:a", "2026-09-12T04:00:00.000Z");
    const young = c.open("user:bob", "class:a", "2026-09-12T04:00:00.001Z");
    const withSession = c.open("user:cara", "class:a", "2026-09-12T03:00:00.000Z");
    for (const runId of [old, young, withSession]) {
      c.touch(runId, "2026-09-12T11:59:00.000Z");
      c.expireLeases(runId, "2026-09-12T04:10:00.000Z");
    }
    c.signIn("cara-live", "user:cara", "2026-09-12T11:00:00.000Z", "2026-09-12T12:30:00.000Z");

    expect(abandoned(c)).toBe(1);
    expect(c.run(old)).toMatchObject({ state: "closed", close_reason: "session-expired" });
    expect(c.run(young)?.state).toBe("active");
    expect(c.run(withSession)?.state).toBe("active");

    // An expired or revoked session is not live, and another student's session is irrelevant.
    c.signIn("alice-other", "user:alice", "2026-09-12T11:00:00.000Z", "2026-09-12T13:00:00.000Z");
    c.f.database.execute("UPDATE marea_auth_sessions SET revoked_at = ?1 WHERE token_hash = ?2", [
      CLOSURE_NOW,
      "cara-live",
    ]);
    expect(abandoned(c)).toBe(1);
    expect(c.run(withSession)?.state).toBe("closed");
    expect(c.run(young)?.state).toBe("active");
  });

  it("never closes a run whose session expires at the same instant as the check, nor an unexpired lease", () => {
    const c = closureClassroom();
    const runId = c.open("user:alice", "class:a", "2026-09-12T02:00:00.000Z");
    c.touch(runId, "2026-09-12T11:59:00.000Z");
    c.expireLeases(runId, "2026-09-12T12:00:00.001Z");
    expect(abandoned(c)).toBe(0);
    c.expireLeases(runId, "2026-09-12T11:00:00.000Z");
    c.signIn("alice", "user:alice", "2026-09-12T04:00:00.000Z", "2026-09-12T12:00:00.001Z");
    expect(abandoned(c)).toBe(0);
    c.f.database.execute("UPDATE marea_auth_sessions SET expires_at = ?1", [CLOSURE_NOW]);
    expect(abandoned(c)).toBe(1);
  });

  it("rechecks every condition inside the closing transaction so a reconnected student stays", () => {
    const c = closureClassroom();
    const runId = c.open("user:alice");
    const other = c.open("user:bob");
    const database = c.f.database;
    const scan = database.readAll.bind(database);
    // The student reconnects (a renewed lease) between the scan and the closing transaction.
    database.readAll = (sql, parameters) => {
      const rows = scan(sql, parameters);
      if (sql.includes("LIMIT 500")) {
        database.execute("UPDATE marea_active_runs SET last_activity_at = ?1 WHERE run_id = ?2", [
          "2026-09-12T11:59:00.000Z",
          runId,
        ]);
      }
      return rows;
    };
    expect(abandoned(c)).toBe(1);
    expect(c.run(runId)?.state).toBe("active");
    expect(c.run(other)?.state).toBe("closed");
    expect(c.events(runId).map((event) => event.event_type)).toEqual(["run-activated"]);
  });

  it("closes the oldest idle runs first and leaves closed runs and later events alone", () => {
    const c = closureClassroom();
    const newer = c.open("user:alice");
    const older = c.open("user:bob");
    c.touch(newer, "2026-09-12T10:30:00.000Z");
    c.touch(older, "2026-09-12T10:10:00.000Z");
    let counter = 0;
    const order: string[] = [];
    expect(
      abandoned(c, {
        createEventId: () => {
          order.push(c.createEventId());
          return `event:order:${String(++counter)}`;
        },
      }),
    ).toBe(2);
    expect(
      CanonicalRunEventSchema.parse(JSON.parse(String(c.events(older).at(-1)?.payload_json)))
        .eventId,
    ).toBe("event:order:1");
    expect(
      CanonicalRunEventSchema.parse(JSON.parse(String(c.events(newer).at(-1)?.payload_json)))
        .eventId,
    ).toBe("event:order:2");
    expect(abandoned(c)).toBe(0);
  });
});

describe("closing runs for a teacher", () => {
  const input = (c: ReturnType<typeof closureClassroom>, overrides = {}) => ({
    classId: null,
    closedAt: CLOSURE_NOW,
    createEventId: c.createEventId,
    reason: "teacher-ended" as const,
    runIds: [] as string[],
    teacherId: "user:teacher",
    ...overrides,
  });

  it("ends one run, recording the teacher, and repeats without error or a second event", () => {
    const c = closureClassroom();
    const runId = c.open("user:alice");
    const result = c.closures.closeRuns(input(c, { runIds: [runId] }));
    expect(result).toEqual({ closed: [runId], unchanged: [] });
    expect(c.run(runId)).toEqual({
      state: "closed",
      closed_at: CLOSURE_NOW,
      close_reason: "teacher-ended",
      closed_by: "user:teacher",
    });
    expect(JSON.parse(String(c.events(runId).at(-1)?.payload_json))).toMatchObject({
      eventType: "run-closed",
      reason: "teacher-ended",
      sequence: 2,
    });
    const repeated = c.closures.closeRuns(
      input(c, { runIds: [runId], closedAt: "2026-09-12T12:05:00.000Z" }),
    );
    expect(repeated).toEqual({ closed: [], unchanged: [runId] });
    expect(c.events(runId)).toHaveLength(2);
    expect(c.run(runId)?.closed_at).toBe(CLOSURE_NOW);
    expect(
      c.f.database.readAll("SELECT revoked_at FROM marea_run_leases WHERE run_id = ?1", [runId]),
    ).toEqual([{ revoked_at: CLOSURE_NOW }]);
  });

  it("refuses a run of a class the teacher does not teach, or one that does not exist", () => {
    const c = closureClassroom();
    const alice = c.open("user:alice");
    const dave = c.open("user:dave", "class:second");
    for (const runId of [dave, "run:missing"]) {
      expect(() => c.closures.closeRuns(input(c, { runIds: [runId] }))).toThrow(
        expect.objectContaining({ code: "run.unavailable" }),
      );
    }
    c.f.database.execute(
      "UPDATE marea_governance_accounts SET state = 'disabled' WHERE user_id = 'user:teacher'",
    );
    expect(() => c.closures.closeRuns(input(c, { runIds: [alice] }))).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
    expect(c.run(alice)?.state).toBe("active");
    expect(c.run(dave)?.state).toBe("active");
  });

  it("ends only the listed runs of a class as class-ended, atomically", () => {
    const c = closureClassroom();
    const alice = c.open("user:alice");
    const bob = c.open("user:bob");
    const cara = c.open("user:cara");
    const dave = c.open("user:dave", "class:second");
    const result = c.closures.closeRuns(
      input(c, {
        classId: "class:a",
        reason: "class-ended",
        runIds: [alice, bob, dave, "run:missing"],
      }),
    );
    expect(result).toEqual({ closed: [alice, bob], unchanged: [dave, "run:missing"] });
    for (const runId of [alice, bob])
      expect(c.run(runId)).toMatchObject({
        state: "closed",
        close_reason: "class-ended",
        closed_by: "user:teacher",
      });
    expect(c.run(cara)?.state).toBe("active");
    expect(c.run(dave)?.state).toBe("active");

    expect(
      c.closures.closeRuns(
        input(c, { classId: "class:a", reason: "class-ended", runIds: [alice] }),
      ),
    ).toEqual({ closed: [], unchanged: [alice] });
  });

  it("refuses a class the teacher does not teach before closing anything", () => {
    const c = closureClassroom();
    const alice = c.open("user:alice");
    expect(() =>
      c.closures.closeRuns(
        input(c, { classId: "class:second", reason: "class-ended", runIds: [alice] }),
      ),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
    expect(() =>
      c.closures.closeRuns(
        input(c, {
          classId: "class:a",
          reason: "class-ended",
          teacherId: "user:alice",
          runIds: [alice],
        }),
      ),
    ).toThrow(TeacherDomainError);
    expect(c.run(alice)?.state).toBe("active");
  });

  it("rolls the whole class closure back when one run cannot be closed", () => {
    const c = closureClassroom();
    const alice = c.open("user:alice");
    const bob = c.open("user:bob");
    c.f.database.execute("DELETE FROM marea_active_runs WHERE run_id = ?1", [bob]);
    expect(() =>
      c.closures.closeRuns(
        input(c, { classId: "class:a", reason: "class-ended", runIds: [alice, bob] }),
      ),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    expect(c.run(alice)?.state).toBe("active");
    expect(c.events(alice)).toHaveLength(1);
  });
});

describe("evaluation after a server-side close", () => {
  function evaluable(automatic: boolean) {
    const c = closureClassroom();
    const runId = c.open("user:alice");
    c.f.database.execute(
      "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES ('snapshot:alice', ?1)",
      [JSON.stringify({ automaticEvaluation: automatic, evaluationSkills: [{ id: "grade" }] })],
    );
    c.runs.appendEvents({
      events: [
        CanonicalRunEventSchema.parse({
          content: "Hello",
          eventId: "event:alice:hello",
          eventType: "student-message",
          occurredAt: "2026-09-12T10:01:00.000Z",
          sequence: 2,
        }),
      ],
      leaseTokenHash: "lease:alice:opened",
      now: "2026-09-12T10:01:00.000Z",
    });
    return { c, runId, evaluations: new SqliteEvaluationRepository(c.f.database) };
  }

  it("makes a teacher-ended run a candidate only when the class enabled automatic evaluation", () => {
    for (const [automatic, candidates] of [
      [true, ["run:alice"]],
      [false, []],
    ] as const) {
      const { c, runId, evaluations } = evaluable(automatic);
      expect(evaluations.automaticCandidates()).toEqual([]);
      c.closures.closeRuns({
        classId: null,
        closedAt: CLOSURE_NOW,
        createEventId: c.createEventId,
        reason: "teacher-ended",
        runIds: [runId],
        teacherId: "user:teacher",
      });
      expect(evaluations.automaticCandidates()).toEqual(candidates);
    }
  });

  it("makes an abandoned run a candidate once the server closes it", () => {
    const { c, evaluations } = evaluable(true);
    expect(evaluations.automaticCandidates()).toEqual([]);
    expect(abandoned(c)).toBe(1);
    expect(evaluations.automaticCandidates()).toEqual(["run:alice"]);
  });
});

describe("refusing a closed run", () => {
  it("names the server reason only for server-side closures", () => {
    const c = closureClassroom();
    const runId = c.open("user:alice");
    c.closures.closeRuns({
      classId: null,
      closedAt: CLOSURE_NOW,
      createEventId: c.createEventId,
      reason: "teacher-ended",
      runIds: [runId],
      teacherId: "user:teacher",
    });
    const refused = (operation: () => unknown) => {
      try {
        operation();
      } catch (error) {
        return error;
      }
      throw new Error("Expected a refusal");
    };
    const lease = refused(() =>
      c.runs.authorizeLease({ leaseTokenHash: "lease:alice:opened", now: CLOSURE_OPENED }),
    );
    expect(lease).toMatchObject({ code: "run.unavailable", reason: "teacher-ended" });
    const renewal = refused(() =>
      c.runs.renewLease({
        classId: "class:a",
        expiresAt: CLOSURE_NOW,
        issuedAt: CLOSURE_OPENED,
        leaseId: "lease:again",
        leaseTokenHash: "lease:again",
        runId,
        studentId: "user:alice",
      }),
    );
    expect(renewal).toMatchObject({ code: "run.unavailable", reason: "teacher-ended" });
    expect(new Set([lease, renewal].map((error) => (error as Error).constructor.name))).toEqual(
      new Set(["RunClosedError"]),
    );
  });
});

describe("refusing to reopen a closed run", () => {
  const closeAs = (c: ReturnType<typeof closureClassroom>, runId: string, reason: string) => {
    if (reason === "student-exit") {
      c.runs.closeRunAuthenticated({
        classId: "class:a",
        closedAt: CLOSURE_NOW,
        closingEventId: "event:student:closed",
        reason,
        runId,
        studentId: "user:alice",
      });
    } else if (reason === "session-expired") {
      abandoned(c);
    } else {
      c.closures.closeRuns({
        classId: null,
        closedAt: CLOSURE_NOW,
        createEventId: c.createEventId,
        reason: reason as "teacher-ended" | "class-ended",
        runIds: [runId],
        teacherId: "user:teacher",
      });
    }
  };
  const resume = (c: ReturnType<typeof closureClassroom>, runId: string, key: string) => () =>
    c.open("user:alice", "class:a", CLOSURE_NOW, {
      idempotencyKey: key,
      intent: { kind: "resume" },
      resumeRunId: runId,
    });

  it.each([
    ["teacher-ended", "RunClosedError"],
    ["class-ended", "RunClosedError"],
    ["session-expired", "RunClosedError"],
    ["student-exit", "TeacherDomainError"],
  ])("explains a %s resume refusal only when the server closed the run", (reason, kind) => {
    const c = closureClassroom();
    const runId = c.open("user:alice");
    closeAs(c, runId, reason);
    let refusal: unknown;
    try {
      resume(c, runId, "resume:closed")();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "run.unavailable" });
    expect((refusal as Error).constructor.name).toBe(kind);
    if (kind === "RunClosedError") expect(refusal).toMatchObject({ reason });
    // Another student never learns why a run of someone else was closed.
    expect(() =>
      c.open("user:bob", "class:a", CLOSURE_NOW, {
        idempotencyKey: "resume:foreign",
        intent: { kind: "resume" },
        resumeRunId: runId,
      }),
    ).toThrow(expect.objectContaining({ constructor: TeacherDomainError }));
  });

  it("explains the refusal when the same open request is repeated after the server closed the run", () => {
    const c = closureClassroom();
    const runId = c.open("user:alice");
    closeAs(c, runId, "teacher-ended");
    let refusal: unknown;
    try {
      c.open("user:alice");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "run.unavailable", reason: "teacher-ended" });
  });

  it("refuses a resume of a run that never existed without a reason", () => {
    const c = closureClassroom();
    c.open("user:alice");
    let refusal: unknown;
    try {
      resume(c, "run:missing", "resume:missing")();
    } catch (error) {
      refusal = error;
    }
    expect((refusal as Error).constructor).toBe(TeacherDomainError);
  });
});

it("adds the nullable closing actor as the last column of the runs table", () => {
  const c = closureClassroom();
  const columns = c.f.database.readAll("PRAGMA table_info(marea_runs)").map((row) => row.name);
  expect(columns.at(-1)).toBe("closed_by");
});
