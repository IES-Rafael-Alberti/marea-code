import {
  CanonicalRunEventSchema,
  StudentRunSnapshotSchema,
  type CanonicalRunEvent,
} from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMigrationCatalog } from "@marea/sqlite-storage/migrations";
import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import type { AuthenticatedIdentity, PreparedIdentityBootstrap } from "../../identity/contracts.js";
import type { OpenStoredRunInput } from "../../sessions/contracts.js";
import { SqliteClassroomRepository } from "./sqlite-classroom-repository.js";
import { SqliteDashboardRepository } from "./sqlite-dashboard-repository.js";
import { SqliteIdentityRepository } from "./sqlite-identity-repository.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

const NOW = "2026-09-03T10:00:00.000Z";
const LATER = "2026-09-03T10:05:00.000Z";
const ALICE: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Student Alice",
  role: "student",
  userId: "user:alice",
};
const BOB: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Student Bob",
  role: "student",
  userId: "user:bob",
};
const SNAPSHOT = StudentRunSnapshotSchema.parse({
  agentMode: "tutoring",
  didacticSkills: [],
  id: "snapshot:alice",
  modelAlias: "marea",
  prompt: {
    content: "Teach with questions.",
    digest: `sha256:${"a".repeat(64)}`,
    version: "prompt-v1",
  },
  teacherToolPolicy: { restrictions: [], version: "policy-v1" },
});
const SEED: PreparedIdentityBootstrap = {
  accounts: [
    {
      classKey: "physics",
      displayName: "Teacher Ada",
      login: "ada",
      passwordHash: "argon:teacher",
      role: "teacher",
      userId: "user:ada",
    },
    {
      classKey: "history",
      displayName: "Teacher Grace",
      login: "grace",
      passwordHash: "argon:teacher",
      role: "teacher",
      userId: "user:grace",
    },
    {
      classKey: "physics",
      displayName: "Student Bob",
      login: "bob",
      passwordHash: "argon:student",
      role: "student",
      userId: "user:bob",
    },
    {
      classKey: null,
      displayName: "Teacher Root",
      login: "root",
      passwordHash: "argon:root",
      role: "teacher",
      userId: "user:root",
    },
  ],
  classes: [
    { classId: "class:physics", displayName: "Physics", key: "physics" },
    { classId: "class:history", displayName: "History", key: "history" },
  ],
  invitations: [
    { classKey: "physics", codeHash: "digest:invite" },
    { classKey: "physics", codeHash: "digest:duplicate-login" },
  ],
  seedId: "fixtures-v1",
};

function openInput(
  student: AuthenticatedIdentity,
  suffix: string,
  change: Partial<OpenStoredRunInput> = {},
): OpenStoredRunInput {
  return {
    activatedEventId: `event:activated:${suffix}`,
    clientSessionId: `client:${suffix}`,
    expiresAt: "2026-09-03T10:10:00.000Z",
    fingerprint: `fingerprint:${suffix}`,
    idempotencyKey: `open:${suffix}`,
    intent: { kind: "new" },
    issuedAt: NOW,
    leaseId: `lease:${suffix}`,
    leaseTokenHash: `digest:lease:${suffix}`,
    openedAt: NOW,
    projectDisplayName: `Project ${suffix}`,
    proposedRunId: `run:${suffix}`,
    requestId: `request:${suffix}`,
    captureSnapshot: () => ({
      providerRoute: { model: "upstream-model", providerId: "openrouter" },
      snapshot: StudentRunSnapshotSchema.parse({ ...SNAPSHOT, id: `snapshot:${suffix}` }),
    }),
    student,
    ...change,
  };
}

function message(eventId: string, sequence: number, occurredAt = LATER): CanonicalRunEvent {
  return CanonicalRunEventSchema.parse({
    content: "Hello",
    eventId,
    eventType: "student-message",
    occurredAt,
    sequence,
  });
}

function enrollAlice(database: NodeSqliteTestDatabase): void {
  const identities = new SqliteIdentityRepository(database);
  identities.applyBootstrap(SEED, NOW);
  identities.consumeInvitation({
    codeHash: "digest:invite",
    displayName: "Student Alice",
    enrolledAt: NOW,
    login: "alice",
    passwordHash: "argon:alice",
    userId: "user:alice",
  });
}

describe("SQLite teacher repository integration", () => {
  let database: NodeSqliteTestDatabase;

  beforeEach(() => {
    database = new NodeSqliteTestDatabase();
    for (const migration of createMigrationCatalog()) {
      for (const statement of migration.statements) {
        database.executeScript(statement);
      }
    }
  });

  afterEach(() => {
    database.close();
  });

  it("persists enrollment and revocable authentication without plaintext secrets", () => {
    const identities = new SqliteIdentityRepository(database);
    expect(identities.applyBootstrap(SEED, NOW)).toBe(true);
    expect(identities.applyBootstrap(SEED, LATER)).toBe(false);
    expect(identities.findCredential("ada")).toMatchObject({
      classId: "class:physics",
      role: "teacher",
      userId: "user:ada",
    });
    expect(
      database.readAll("SELECT teacher_id FROM marea_teacher_classes ORDER BY teacher_id"),
    ).toEqual([{ teacher_id: "user:ada" }, { teacher_id: "user:grace" }]);

    const enrollment = identities.consumeInvitation({
      codeHash: "digest:invite",
      displayName: "Student Alice",
      enrolledAt: NOW,
      login: "alice",
      passwordHash: "argon:alice",
      userId: "user:alice",
    });
    expect(enrollment).toEqual({ enrolled: true, identity: ALICE });
    expect(
      identities.consumeInvitation({
        codeHash: "digest:invite",
        displayName: "Replay",
        enrolledAt: LATER,
        login: "replay",
        passwordHash: "argon:replay",
        userId: "user:replay",
      }),
    ).toEqual({ enrolled: false });
    expect(
      identities.consumeInvitation({
        codeHash: "digest:duplicate-login",
        displayName: "Duplicate Alice",
        enrolledAt: LATER,
        login: "alice",
        passwordHash: "argon:different",
        userId: "user:different",
      }),
    ).toEqual({ enrolled: false });
    expect(
      database.readOne("SELECT password_hash FROM marea_users WHERE id = ?1", ["user:alice"]),
    ).toEqual({
      password_hash: "argon:alice",
    });

    identities.createSession({
      expiresAt: "2026-09-03T10:30:00.000Z",
      issuedAt: NOW,
      sessionId: "session:alice",
      tokenHash: "digest:session-token",
      userId: "user:alice",
    });
    expect(identities.resolveSession("digest:session-token", NOW)).toEqual(ALICE);
    expect(identities.resolveSession("session-token", NOW)).toBeUndefined();
    expect(identities.revokeSession("digest:session-token", LATER)).toBe(true);
    expect(identities.revokeSession("digest:session-token", LATER)).toBe(false);
    expect(identities.resolveSession("digest:session-token", NOW)).toBeUndefined();
  });

  it("derives bootstrap and dashboard data through class authority", () => {
    enrollAlice(database);
    const runs = new SqliteRunSessionRepository(database);
    const opened = runs.openRun(openInput(ALICE, "alice"));
    expect(opened.snapshot.id).toBe("snapshot:alice");
    expect(new SqliteClassroomRepository(database).loadStudentBootstrap(ALICE)).toEqual({
      activeRun: { projectDisplayName: "Project alice", runId: "run:alice" },
      classDisplayName: "Physics",
    });

    expect(
      runs.appendEvents({
        events: [message("event:message:alice", 2)],
        leaseTokenHash: "digest:lease:alice",
        now: LATER,
      }),
    ).toBe(2);
    const dashboard = new SqliteDashboardRepository(database);
    expect(
      dashboard.listActiveRuns({ cursor: undefined, limit: 10, teacherId: "user:ada" }).runs,
    ).toEqual([
      expect.objectContaining({
        highestDurableSequence: 2,
        lastActivityAt: LATER,
        runId: "run:alice",
        studentDisplayName: "Student Alice",
      }),
    ]);
    expect(
      dashboard.listActiveRuns({ cursor: undefined, limit: 10, teacherId: "user:grace" }).runs,
    ).toEqual([]);
    runs.openRun(openInput(BOB, "bob", { openedAt: LATER, issuedAt: LATER }));
    const firstPage = dashboard.listActiveRuns({
      cursor: undefined,
      limit: 1,
      teacherId: "user:ada",
    });
    expect(firstPage.runs[0]?.runId).toBe("run:bob");
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = firstPage.nextCursor;
    if (cursor === null) {
      throw new Error("Expected a dashboard continuation cursor.");
    }
    expect(
      dashboard.listActiveRuns({
        cursor,
        limit: 1,
        teacherId: "user:ada",
      }).runs[0]?.runId,
    ).toBe("run:alice");
  });

  it("keeps run snapshots, retries, lease scope, events, resume, and close atomic", () => {
    enrollAlice(database);
    const repository = new SqliteRunSessionRepository(database);
    const initial = openInput(ALICE, "alice");
    expect(repository.openRun(initial).runId).toBe("run:alice");

    const retry = openInput(ALICE, "alice", {
      activatedEventId: "event:unused",
      leaseId: "lease:alice:retry",
      leaseTokenHash: "digest:lease:alice:retry",
      proposedRunId: "run:unused",
      captureSnapshot: () => ({
        providerRoute: { model: "changed", providerId: "openrouter" },
        snapshot: StudentRunSnapshotSchema.parse({ ...SNAPSHOT, id: "snapshot:changed" }),
      }),
    });
    expect(repository.openRun(retry)).toEqual({
      highestDurableSequence: 1,
      runId: "run:alice",
      snapshot: SNAPSHOT,
    });
    expect(
      repository.authorizeLease({
        leaseTokenHash: "digest:lease:alice:retry",
        now: NOW,
      }),
    ).toEqual({
      providerRoute: { model: "upstream-model", providerId: "openrouter" },
      runId: "run:alice",
      studentId: "user:alice",
    });
    expect(database.readOne("SELECT COUNT(*) AS count FROM marea_runs")).toEqual({ count: 1n });
    expect(database.readOne("SELECT COUNT(*) AS count FROM marea_run_snapshots")).toEqual({
      count: 1n,
    });
    expect(() =>
      repository.appendEvents({
        events: [message("event:old-lease", 2)],
        leaseTokenHash: "digest:lease:alice",
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    expect(() =>
      repository.appendEvents({
        events: [message("event:unknown-lease", 2)],
        leaseTokenHash: "digest:lease:unknown",
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));

    const canonical = message("event:message", 2);
    const append = {
      events: [canonical],
      leaseTokenHash: "digest:lease:alice:retry",
      now: LATER,
    } as const;
    expect(repository.appendEvents(append)).toBe(2);
    expect(repository.appendEvents(append)).toBe(2);
    expect(database.readOne("SELECT COUNT(*) AS count FROM marea_run_events")).toEqual({
      count: 2n,
    });
    expect(() => repository.appendEvents({ ...append, events: [message("event:gap", 4)] })).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );

    for (const { projectDisplayName, student, suffix } of [
      { projectDisplayName: "Project alice", student: BOB, suffix: "foreign" },
      { projectDisplayName: "Project other", student: ALICE, suffix: "wrong-project" },
    ] as const) {
      expect(() =>
        repository.openRun(
          openInput(student, suffix, {
            intent: { kind: "resume" },
            projectDisplayName,
            resumeRunId: "run:alice",
          }),
        ),
      ).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    }

    const resumed = repository.openRun(
      openInput(ALICE, "resume", {
        fingerprint: "fingerprint:resume",
        idempotencyKey: "resume:alice",
        intent: { kind: "resume" },
        leaseTokenHash: "digest:lease:resumed",
        projectDisplayName: "Project alice",
        resumeRunId: "run:alice",
      }),
    );
    expect(resumed).toEqual({
      highestDurableSequence: 2,
      runId: "run:alice",
      snapshot: SNAPSHOT,
    });
    expect(() =>
      repository.authorizeLease({
        leaseTokenHash: "digest:lease:alice:retry",
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));

    expect(
      repository.renewLease({
        expiresAt: "2026-09-03T10:15:00.000Z",
        issuedAt: LATER,
        leaseId: "lease:renewed",
        leaseTokenHash: "digest:lease:renewed",
        runId: "run:alice",
        studentId: ALICE.userId,
      }),
    ).toEqual({
      expiresAt: "2026-09-03T10:15:00.000Z",
      issuedAt: LATER,
      runId: "run:alice",
    });
    expect(() =>
      repository.authorizeLease({
        leaseTokenHash: "digest:lease:resumed",
        now: LATER,
      }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    expect(() =>
      repository.renewLease({
        expiresAt: "2026-09-03T10:15:00.000Z",
        issuedAt: LATER,
        leaseId: "lease:foreign",
        leaseTokenHash: "digest:lease:foreign",
        runId: "run:alice",
        studentId: BOB.userId,
      }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));

    const close = {
      closedAt: "2026-09-03T10:20:00.000Z",
      closingEventId: "event:closed:authenticated",
      reason: "student-exit" as const,
      runId: "run:alice",
      studentId: ALICE.userId,
    };
    expect(() => repository.closeRunAuthenticated({ ...close, studentId: BOB.userId })).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
    expect(repository.closeRunAuthenticated(close)).toEqual({
      alreadyClosed: false,
      runId: "run:alice",
    });
    expect(repository.closeRunAuthenticated(close)).toEqual({
      alreadyClosed: true,
      runId: "run:alice",
    });
    expect(
      database.readOne("SELECT state, close_reason FROM marea_runs WHERE id = ?1", ["run:alice"]),
    ).toEqual({
      close_reason: "student-exit",
      state: "closed",
    });
    expect(
      new SqliteDashboardRepository(database).listActiveRuns({
        cursor: undefined,
        limit: 10,
        teacherId: "user:ada",
      }).runs,
    ).toEqual([]);
  });

  it("recovers an active run after lease expiry but never revives old bearers or closed runs", () => {
    enrollAlice(database);
    const repository = new SqliteRunSessionRepository(database);
    repository.openRun(openInput(ALICE, "expired"));
    const afterExpiry = "2026-09-03T10:11:00.000Z";
    expect(() =>
      repository.authorizeLease({
        leaseTokenHash: "digest:lease:expired",
        now: afterExpiry,
      }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));

    repository.renewLease({
      expiresAt: "2026-09-03T10:21:00.000Z",
      issuedAt: afterExpiry,
      leaseId: "lease:recovered",
      leaseTokenHash: "digest:lease:recovered",
      runId: "run:expired",
      studentId: ALICE.userId,
    });
    expect(() =>
      repository.authorizeLease({ leaseTokenHash: "digest:lease:expired", now: afterExpiry }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    expect(
      repository.authorizeLease({
        leaseTokenHash: "digest:lease:recovered",
        now: afterExpiry,
      }).runId,
    ).toBe("run:expired");

    repository.closeRunAuthenticated({
      closedAt: "2026-09-03T10:12:00.000Z",
      closingEventId: "event:closed:expired",
      reason: "student-exit",
      runId: "run:expired",
      studentId: ALICE.userId,
    });
    expect(() =>
      repository.renewLease({
        expiresAt: "2026-09-03T10:30:00.000Z",
        issuedAt: "2026-09-03T10:20:00.000Z",
        leaseId: "lease:closed",
        leaseTokenHash: "digest:lease:closed",
        runId: "run:expired",
        studentId: ALICE.userId,
      }),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    expect(() =>
      repository.openRun(
        openInput(ALICE, "closed-resume", {
          intent: { kind: "resume" },
          projectDisplayName: "Project expired",
          resumeRunId: "run:expired",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "run.unavailable" }));
  });
});
