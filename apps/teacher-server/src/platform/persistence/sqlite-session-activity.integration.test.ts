import { CanonicalRunEventSchema, StudentRunSnapshotSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { governanceFixture, seedGovernancePilot } from "./governance-repository.fixture.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

const OPENED = "2026-09-12T10:00:00.000Z";
const ALICE: AuthenticatedIdentity = {
  classId: "class:a",
  displayName: "Person",
  role: "student",
  userId: "user:alice",
};

function classroom() {
  const f = governanceFixture();
  seedGovernancePilot(f);
  for (const [userId, role] of [
    ["user:alice", "student"],
    ["user:bob", "student"],
    ["user:teacher", "teacher"],
  ] as const) {
    f.createAccount("center:a", userId, role, "class:a");
    f.activate("center:a", userId);
  }
  const runs = new SqliteRunSessionRepository(f.database);
  runs.openRun({
    activatedEventId: "event:alice:activated",
    clientSessionId: "client:alice",
    expiresAt: "2026-09-12T10:10:00.000Z",
    fingerprint: "fingerprint:alice",
    idempotencyKey: "open:alice",
    intent: { kind: "new" },
    issuedAt: OPENED,
    leaseId: "lease:alice:opened",
    leaseTokenHash: "lease:alice:opened",
    openedAt: OPENED,
    projectDisplayName: "Lab",
    proposedRunId: "run:alice",
    requestId: "request:alice:open",
    captureSnapshot: () => ({
      providerRoute: { model: "model", providerId: "provider" },
      snapshot: StudentRunSnapshotSchema.parse({
        agentMode: "tutoring",
        didacticSkills: [],
        id: "snapshot:alice",
        modelAlias: "marea",
        prompt: { content: "Ask.", digest: `sha256:${"b".repeat(64)}`, version: "v1" },
        teacherToolPolicy: { restrictions: [], version: "v1" },
      }),
    }),
    student: ALICE,
  });
  const signIn = (token: string, userId: string, issuedAt: string, expiresAt: string) => {
    f.identities.createSession({
      classId: "class:a",
      expiresAt,
      issuedAt,
      sessionId: `session:${token}`,
      tokenHash: token,
      userId,
    });
  };
  /** The policy the identity service applies: 30 idle minutes within 8 hours. */
  const extend = (tokenHash: string, now: string, runId = "run:alice") => {
    const at = Date.parse(now);
    return f.identities.extendSessionForRunActivity({
      activitySince: new Date(at - 1_800_000).toISOString(),
      expiresAt: new Date(at + 1_800_000).toISOString(),
      maxLifetimeSeconds: 28_800,
      now,
      runId,
      tokenHash,
    });
  };
  return { f, runs, signIn, extend };
}

describe("SQLite student session activity", () => {
  it("slides only a live session of the run's own student, within the absolute lifetime", () => {
    const { f, signIn, extend } = classroom();
    signIn("alice", "user:alice", OPENED, "2026-09-12T10:30:00.000Z");
    signIn("bob", "user:bob", OPENED, "2026-09-12T10:30:00.000Z");
    signIn("teacher", "user:teacher", OPENED, "2026-09-12T10:30:00.000Z");
    signIn("lapsed", "user:alice", OPENED, "2026-09-12T10:20:00.000Z");
    signIn("capped", "user:alice", "2026-09-12T02:40:00.000Z", "2026-09-12T10:28:00.000Z");
    signIn("exhausted", "user:alice", "2026-09-12T02:30:00.000Z", "2026-09-12T10:30:00.000Z");
    const at = "2026-09-12T10:25:00.000Z";

    expect(extend("alice", at)).toBe("2026-09-12T10:55:00.000Z");
    expect(f.identities.resolveSession("alice", "2026-09-12T10:40:00.000Z")).toEqual(ALICE);
    expect(extend("capped", at)).toBe("2026-09-12T10:40:00.000Z");
    expect(extend("exhausted", at)).toBeUndefined();
    expect(extend("lapsed", at)).toBeUndefined();
    expect(extend("bob", at)).toBeUndefined();
    expect(extend("teacher", at)).toBeUndefined();
    expect(extend("alice", at, "run:missing")).toBeUndefined();
    expect(f.identities.resolveSession("lapsed", at)).toBeUndefined();
  });

  it("lets an idle session lapse, resumes with activity, and never outlives revocation or close", () => {
    const { f, runs, signIn, extend } = classroom();
    signIn("alice", "user:alice", OPENED, "2026-09-12T10:30:00.000Z");
    expect(extend("alice", "2026-09-12T10:25:00.000Z")).toBe("2026-09-12T10:55:00.000Z");
    // The run has been quiet since it opened at 10:00.
    expect(extend("alice", "2026-09-12T10:50:00.000Z")).toBeUndefined();

    runs.renewLease({
      classId: "class:a",
      expiresAt: "2026-09-12T11:00:00.000Z",
      issuedAt: "2026-09-12T10:50:00.000Z",
      leaseId: "lease:alice:working",
      leaseTokenHash: "lease:alice:working",
      runId: "run:alice",
      studentId: "user:alice",
    });
    expect(extend("alice", "2026-09-12T10:50:00.000Z")).toBe("2026-09-12T11:20:00.000Z");
    runs.appendEvents({
      events: [
        CanonicalRunEventSchema.parse({
          content: "Hello",
          eventId: "event:alice:working",
          eventType: "student-message",
          occurredAt: "2026-09-11T10:51:00.000Z",
          sequence: 2,
        }),
      ],
      leaseTokenHash: "lease:alice:working",
      now: "2026-09-12T10:51:00.000Z",
    });
    expect(extend("alice", "2026-09-12T10:52:00.000Z")).toBe("2026-09-12T11:22:00.000Z");

    expect(f.identities.revokeSession("alice", "2026-09-12T10:53:00.000Z")).toBe(true);
    expect(extend("alice", "2026-09-12T10:54:00.000Z")).toBeUndefined();
    expect(
      f.database.readOne("SELECT expires_at FROM marea_auth_sessions WHERE token_hash = 'alice'"),
    ).toEqual({ expires_at: "2026-09-12T11:22:00.000Z" });

    signIn("closing", "user:alice", "2026-09-12T10:54:00.000Z", "2026-09-12T11:24:00.000Z");
    runs.closeRunAuthenticated({
      classId: "class:a",
      closedAt: "2026-09-12T10:55:00.000Z",
      closingEventId: "event:alice:closed",
      reason: "student-exit",
      runId: "run:alice",
      studentId: "user:alice",
    });
    expect(extend("closing", "2026-09-12T10:56:00.000Z")).toBeUndefined();
  });
});

it("slides authenticated teacher activity without reviving sessions or exceeding eight hours", () => {
  const { f, signIn } = classroom();
  signIn("teacher", "user:teacher", OPENED, "2026-09-12T10:30:00.000Z");
  const expiry = () =>
    f.database.readOne("SELECT expires_at FROM marea_auth_sessions WHERE token_hash = 'teacher'");
  expect(f.identities.resolveSession("teacher", "2026-09-12T10:29:00.000Z")?.role).toBe("teacher");
  expect(expiry()).toEqual({ expires_at: "2026-09-12T10:59:00.000Z" });
  expect(f.identities.resolveSession("teacher", "2026-09-12T10:59:00.000Z")).toBeUndefined();
  expect(expiry()).toEqual({ expires_at: "2026-09-12T10:59:00.000Z" });
  signIn("capped-teacher", "user:teacher", "2026-09-12T02:40:00.000Z", "2026-09-12T10:30:00.000Z");
  expect(f.identities.resolveSession("capped-teacher", "2026-09-12T10:29:00.000Z")?.role).toBe(
    "teacher",
  );
  expect(
    f.database.readOne(
      "SELECT expires_at FROM marea_auth_sessions WHERE token_hash = 'capped-teacher'",
    ),
  ).toEqual({ expires_at: "2026-09-12T10:40:00.000Z" });
  f.identities.revokeSession("capped-teacher", "2026-09-12T10:30:00.000Z");
  expect(f.identities.resolveSession("capped-teacher", "2026-09-12T10:31:00.000Z")).toBeUndefined();
  signIn("disabled-teacher", "user:teacher", OPENED, "2026-09-12T10:30:00.000Z");
  f.database.execute(
    "UPDATE marea_governance_accounts SET state = 'disabled' WHERE user_id = 'user:teacher'",
  );
  expect(
    f.identities.resolveSession("disabled-teacher", "2026-09-12T10:29:00.000Z"),
  ).toBeUndefined();
  expect(
    f.database.readOne(
      "SELECT expires_at FROM marea_auth_sessions WHERE token_hash = 'disabled-teacher'",
    ),
  ).toEqual({ expires_at: "2026-09-12T10:30:00.000Z" });
});

it("counts only current owned lease presence using the server clock", () => {
  const { f, extend } = classroom();
  const activity = () =>
    f.database.readOne("SELECT last_activity_at FROM marea_active_runs WHERE run_id = 'run:alice'");
  expect(extend("missing", "2026-09-12T10:01:00.000Z")).toBeUndefined();
  expect(activity()).toEqual({ last_activity_at: OPENED });
  expect(extend("lease:alice:opened", "2026-09-12T10:02:00.000Z", "run:other")).toBeUndefined();
  expect(activity()).toEqual({ last_activity_at: OPENED });
  expect(extend("lease:alice:opened", "2026-09-12T10:02:00.000Z")).toBeUndefined();
  expect(activity()).toEqual({ last_activity_at: "2026-09-12T10:02:00.000Z" });
  expect(extend("lease:alice:opened", "2026-09-12T10:10:00.000Z")).toBeUndefined();
  expect(activity()).toEqual({ last_activity_at: "2026-09-12T10:02:00.000Z" });
});
