import { CanonicalRunEventSchema, StudentRunSnapshotSchema } from "@marea/protocol";
import type { CanonicalRunEvent } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { DatabaseFake } from "../../../test-support/database-fake.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import type { OpenStoredRunInput } from "../../sessions/contracts.js";
import {
  activeLeaseRow,
  activeRunProjection as projection,
} from "./sqlite-run-repository.test-support.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

const STUDENT: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Student Alice",
  role: "student",
  userId: "user:alice",
};
const SNAPSHOT = StudentRunSnapshotSchema.parse({
  agentMode: "tutoring",
  didacticSkills: [],
  id: "snapshot:1",
  modelAlias: "marea",
  prompt: {
    content: "Prompt",
    digest: `sha256:${"a".repeat(64)}`,
    version: "prompt-v1",
  },
  teacherToolPolicy: { restrictions: [], version: "policy-v1" },
});

function openInput(change: Partial<OpenStoredRunInput> = {}): OpenStoredRunInput {
  return {
    activatedEventId: "event:activated",
    clientSessionId: "client:alice",
    expiresAt: "2026-09-03T10:10:00.000Z",
    fingerprint: "fingerprint",
    idempotencyKey: "open:alice",
    intent: { kind: "new" },
    issuedAt: "2026-09-03T10:00:00.000Z",
    leaseId: "lease:1",
    leaseTokenHash: "digest:lease",
    openedAt: "2026-09-03T10:00:00.000Z",
    projectDisplayName: "Wave lab",
    proposedRunId: "run:1",
    requestId: "request:open",
    captureSnapshot: () => ({
      providerRoute: { model: "model", providerId: "openrouter" },
      snapshot: SNAPSHOT,
    }),
    student: STUDENT,
    ...change,
  };
}

function storedRunRow(state = "active") {
  return {
    id: "run:1",
    provider_route_json: JSON.stringify({ model: "model", providerId: "openrouter" }),
    public_snapshot_json: JSON.stringify(SNAPSHOT),
    state,
  } as const;
}

function event(
  eventId: string,
  sequence: number,
  eventType: "student-message" | "approval-requested" | "approval-resolved" = "student-message",
): CanonicalRunEvent {
  if (eventType === "approval-requested") {
    return CanonicalRunEventSchema.parse({
      approvalId: "approval:1",
      eventId,
      eventType,
      occurredAt: "2026-09-03T10:02:00.000Z",
      sequence,
      summary: "Approve edit",
      tool: "workspace.write",
    });
  }
  if (eventType === "approval-resolved") {
    return CanonicalRunEventSchema.parse({
      approvalId: "approval:1",
      decision: "approved",
      eventId,
      eventType,
      occurredAt: "2026-09-03T10:03:00.000Z",
      sequence,
    });
  }
  return CanonicalRunEventSchema.parse({
    content: "Hello",
    eventId,
    eventType,
    occurredAt: "2026-09-03T10:01:00.000Z",
    sequence,
  });
}

function rejectedOpen(
  rows: DatabaseFake["oneRows"],
  change: Partial<OpenStoredRunInput> = {},
): () => void {
  return () => {
    const database = new DatabaseFake();
    database.oneRows.push(...rows);
    new SqliteRunSessionRepository(database).openRun(openInput(change));
  };
}

describe("SQLite run session repository opening", () => {
  it("creates a run, immutable snapshot, activation event, projection, and hashed lease", () => {
    const database = new DatabaseFake();
    database.oneRows.push(undefined, projection());
    const result = new SqliteRunSessionRepository(database).openRun(openInput());

    expect(result).toStrictEqual({ highestDurableSequence: 1, runId: "run:1", snapshot: SNAPSHOT });
    expect(database.executions.some(({ sql }) => sql.includes("marea_run_snapshots"))).toBe(true);
    expect(database.executions.some(({ sql }) => sql.includes("marea_active_runs"))).toBe(true);
    expect(database.executions.at(-1)?.parameters).toContain("digest:lease");
    expect(database.reads.map(({ parameters }) => parameters)).toEqual([
      ["user:alice", "class:physics"],
      ["user:alice", "open:alice"],
      ["run:1"],
    ]);
    expect(database.reads[0]?.sql).toContain("marea_governance_memberships");
    expect(database.reads[1]?.sql).toContain("marea_run_open_requests");
    expect(database.reads[2]?.sql).toContain("marea_active_runs");
    expect(database.executions).toHaveLength(7);
    expect(database.executions.every(({ sql }) => sql.length > 0)).toBe(true);
    expect(database.executions.map(({ parameters }) => parameters)).toEqual([
      [
        "snapshot:1",
        JSON.stringify(SNAPSHOT),
        JSON.stringify({ model: "model", providerId: "openrouter" }),
        "2026-09-03T10:00:00.000Z",
      ],
      [
        "run:1",
        "user:alice",
        "class:physics",
        "snapshot:1",
        "client:alice",
        "Wave lab",
        "2026-09-03T10:00:00.000Z",
      ],
      expect.arrayContaining(["event:activated", "run:1", 1, "run-activated"]),
      ["run:1", "user:alice", "class:physics", "Wave lab", "2026-09-03T10:00:00.000Z"],
      ["user:alice", "open:alice", "fingerprint", "run:1"],
      ["run:1", "2026-09-03T10:00:00.000Z"],
      [
        "lease:1",
        "run:1",
        "user:alice",
        "digest:lease",
        "2026-09-03T10:00:00.000Z",
        "2026-09-03T10:10:00.000Z",
      ],
    ]);
  });

  it("returns an idempotent existing run while rotating the lease", () => {
    const database = new DatabaseFake();
    database.oneRows.push(
      { fingerprint: "fingerprint", run_id: "run:1" },
      storedRunRow(),
      projection(4),
    );
    expect(new SqliteRunSessionRepository(database).openRun(openInput())).toEqual({
      highestDurableSequence: 4,
      runId: "run:1",
      snapshot: SNAPSHOT,
    });
    expect(database.executions).toHaveLength(2);
    expect(database.reads[2]?.parameters).toEqual(["run:1", "user:alice"]);
    expect(database.reads[2]?.sql).toContain("marea_run_snapshots");
    expect(
      database.executions.map(({ parameters, sql }) => ({ parameters, sql: sql.length > 0 })),
    ).toEqual([
      { parameters: ["run:1", "2026-09-03T10:00:00.000Z"], sql: true },
      {
        parameters: [
          "lease:1",
          "run:1",
          "user:alice",
          "digest:lease",
          "2026-09-03T10:00:00.000Z",
          "2026-09-03T10:10:00.000Z",
        ],
        sql: true,
      },
    ]);
  });

  it("resumes only the student's matching active run without replacing its snapshot", () => {
    const database = new DatabaseFake();
    database.oneRows.push(undefined, { id: "run:1" }, storedRunRow(), projection(6));
    const result = new SqliteRunSessionRepository(database).openRun(
      openInput({ idempotencyKey: "resume:1", intent: { kind: "resume" } }),
    );
    expect(result.snapshot.id).toBe("snapshot:1");
    expect(result.highestDurableSequence).toBe(6);
    expect(database.executions.some(({ sql }) => sql.includes("marea_run_open_requests"))).toBe(
      true,
    );
    expect(database.reads[2]?.parameters).toEqual(["user:alice", "Wave lab", "class:physics"]);
    expect(database.reads[2]?.sql).toContain("state = 'active'");
    expect(database.executions[0]?.parameters).toEqual([
      "user:alice",
      "resume:1",
      "fingerprint",
      "run:1",
    ]);
    expect(database.executions[0]?.sql).toContain("marea_run_open_requests");
  });

  it("scopes an explicit resume identity to both the student and project", () => {
    const database = new DatabaseFake();
    database.oneRows.push(undefined, { id: "run:1" }, storedRunRow(), projection(6));
    const result = new SqliteRunSessionRepository(database).openRun(
      openInput({
        idempotencyKey: "resume:explicit",
        intent: { kind: "resume" },
        resumeRunId: "run:1",
      }),
    );

    expect(result.runId).toBe("run:1");
    const resume = ["run:1", "user:alice", "Wave lab", "class:physics"];
    expect(database.reads[2]?.parameters).toEqual(resume);
    expect(database.reads[2]?.sql).toContain("project_display_name = ?3");

    for (const change of [
      { resumeRunId: "run:foreign" },
      { projectDisplayName: "Other lab", resumeRunId: "run:1" },
    ]) {
      const rejected = new DatabaseFake();
      rejected.oneRows.push(undefined, undefined);
      expect(() =>
        new SqliteRunSessionRepository(rejected).openRun(
          openInput({
            idempotencyKey: `resume:${change.resumeRunId}:${change.projectDisplayName ?? "same"}`,
            intent: { kind: "resume" },
            ...change,
          }),
        ),
      ).toThrow(expect.objectContaining({ code: "run.unavailable" }));
      expect(rejected.executions).toHaveLength(0);
    }
  });

  it("rejects missing resumes, idempotency conflicts, missing stored runs, and closed runs", () => {
    const attempts: readonly { readonly code: string; readonly operation: () => void }[] = [
      {
        code: "run.unavailable",
        operation: rejectedOpen([undefined, undefined], { intent: { kind: "resume" } }),
      },
      {
        code: "request.conflict",
        operation: rejectedOpen([
          { fingerprint: "different", run_id: "run:1" },
          storedRunRow(),
          projection(),
        ]),
      },
      {
        code: "run.unavailable",
        operation: rejectedOpen([{ fingerprint: "fingerprint", run_id: "run:1" }, undefined]),
      },
      {
        code: "run.unavailable",
        operation: rejectedOpen([
          { fingerprint: "fingerprint", run_id: "run:1" },
          storedRunRow("closed"),
          projection(),
        ]),
      },
      {
        code: "run.unavailable",
        operation: rejectedOpen([undefined, projection()], {
          student: { ...STUDENT, classId: null },
        }),
      },
    ];
    for (const attempt of attempts) {
      expect(attempt.operation).toThrow(expect.objectContaining({ code: attempt.code }));
    }
  });

  it("rejects private provider route metadata outside the strict storage contract", () => {
    const database = new DatabaseFake();
    const unsafeProviderRoute = {
      model: "model",
      providerId: "openrouter",
      secret: "must-not-be-persisted",
    };
    database.oneRows.push(undefined, projection());
    expect(() =>
      new SqliteRunSessionRepository(database).openRun(
        openInput({
          captureSnapshot: () => ({
            providerRoute: unsafeProviderRoute,
            snapshot: SNAPSHOT,
          }),
        }),
      ),
    ).toThrow();
    expect(database.executions).toHaveLength(0);
  });
});

describe("SQLite run session repository events", () => {
  it("appends contiguous events then updates approval and activity projection atomically", () => {
    const database = new DatabaseFake();
    database.oneRows.push(activeLeaseRow(), projection(), undefined, undefined);
    const highest = new SqliteRunSessionRepository(database).appendEvents({
      events: [
        event("event:approval", 2, "approval-requested"),
        event("event:resolved", 3, "approval-resolved"),
      ],
      leaseTokenHash: "digest:lease",
      now: "2026-09-03T10:04:00.000Z",
    });
    expect(highest).toBe(3);
    expect(database.executions.at(-1)?.parameters).toEqual([
      "run:1",
      "2026-09-03T10:03:00.000Z",
      3,
      false,
    ]);
    expect(database.reads[0]?.parameters).toEqual(["digest:lease", "2026-09-03T10:04:00.000Z"]);
    expect(database.reads[0]?.sql).toContain("marea_run_leases");
    expect(database.executions.at(-1)?.sql).toContain("marea_active_runs");
    expect(database.executions).toHaveLength(3);
    expect(database.executions[0]?.sql).toContain("marea_run_events");
    expect(database.executions[1]?.sql).toContain("marea_run_events");
  });

  it("acknowledges an exact duplicate without inserting it again", () => {
    const duplicate = event("event:message", 2);
    const database = new DatabaseFake();
    database.oneRows.push(activeLeaseRow(), projection(2), {
      payload_json: JSON.stringify(duplicate),
      run_id: "run:1",
      sequence: 2,
    });
    expect(
      new SqliteRunSessionRepository(database).appendEvents({
        events: [duplicate],
        leaseTokenHash: "digest:lease",
        now: "now",
      }),
    ).toBe(2);
    expect(database.executions).toHaveLength(1);
    expect(database.reads[2]?.parameters).toEqual(["event:message"]);
    expect(database.reads[2]?.sql).toContain("marea_run_events");
  });

  it("keeps projection activity and approval state for an older ordinary event", () => {
    const database = new DatabaseFake();
    database.oneRows.push(
      activeLeaseRow(),
      {
        highest_durable_sequence: 1,
        last_activity_at: "2026-09-03T10:05:00.000Z",
        pending_approval: 1,
      },
      undefined,
    );
    expect(
      new SqliteRunSessionRepository(database).appendEvents({
        events: [event("event:ordinary", 2)],
        leaseTokenHash: "digest:lease",
        now: "now",
      }),
    ).toBe(2);
    expect(database.executions.at(-1)?.parameters).toEqual([
      "run:1",
      "2026-09-03T10:05:00.000Z",
      2,
      true,
    ]);
  });

  it("sets approval state only after a newly durable approval request", () => {
    const database = new DatabaseFake();
    database.oneRows.push(activeLeaseRow(), projection(), undefined);
    expect(
      new SqliteRunSessionRepository(database).appendEvents({
        events: [event("event:approval", 2, "approval-requested")],
        leaseTokenHash: "digest:lease",
        now: "now",
      }),
    ).toBe(2);
    expect(database.executions.at(-1)?.parameters).toEqual([
      "run:1",
      "2026-09-03T10:02:00.000Z",
      2,
      true,
    ]);
  });

  it("does not project an older duplicate approval request a second time", () => {
    const duplicate = event("event:approval", 2, "approval-requested");
    const database = new DatabaseFake();
    database.oneRows.push(
      activeLeaseRow(),
      {
        highest_durable_sequence: 3,
        last_activity_at: "2026-09-03T10:04:00.000Z",
        pending_approval: 0,
      },
      {
        payload_json: JSON.stringify(duplicate),
        run_id: "run:1",
        sequence: 2,
      },
    );
    expect(
      new SqliteRunSessionRepository(database).appendEvents({
        events: [duplicate],
        leaseTokenHash: "digest:lease",
        now: "now",
      }),
    ).toBe(3);
    expect(database.executions.at(-1)?.parameters).toEqual([
      "run:1",
      "2026-09-03T10:04:00.000Z",
      3,
      false,
    ]);
  });

  it("rejects invalid leases, missing projections, conflicts, gaps, and server-owned events", () => {
    const attempt = (rows: DatabaseFake["oneRows"], events: readonly CanonicalRunEvent[]) => {
      const database = new DatabaseFake();
      database.oneRows.push(...rows);
      return () =>
        new SqliteRunSessionRepository(database).appendEvents({
          events,
          leaseTokenHash: "digest:lease",
          now: "now",
        });
    };
    const message = event("event:message", 2);
    const activated = CanonicalRunEventSchema.parse({
      eventId: "event:activated-again",
      eventType: "run-activated",
      occurredAt: "2026-09-03T10:00:00.000Z",
      sequence: 2,
    });
    const closed = CanonicalRunEventSchema.parse({
      eventId: "event:closed-by-client",
      eventType: "run-closed",
      occurredAt: "2026-09-03T10:00:00.000Z",
      reason: "student-exit",
      sequence: 2,
    });
    for (const operation of [
      attempt([undefined], [message]),
      attempt([activeLeaseRow(), undefined], [message]),
    ]) {
      expect(operation).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    }
    for (const operation of [
      attempt(
        [
          activeLeaseRow(),
          projection(1),
          { payload_json: "different", run_id: "run:1", sequence: 2 },
        ],
        [message],
      ),
      attempt([activeLeaseRow(), projection(1), undefined], [event("event:gap", 3)]),
      attempt([activeLeaseRow(), projection(1)], [activated]),
      attempt([activeLeaseRow(), projection(1)], [closed]),
      attempt(
        [
          activeLeaseRow(),
          projection(2),
          { payload_json: JSON.stringify(message), run_id: "run:other", sequence: 2 },
        ],
        [message],
      ),
      attempt(
        [
          activeLeaseRow(),
          projection(2),
          { payload_json: JSON.stringify(message), run_id: "run:1", sequence: 99 },
        ],
        [message],
      ),
    ]) {
      expect(operation).toThrow(expect.objectContaining({ code: "request.conflict" }));
    }
  });
});
