import { StudentRunSnapshotSchema } from "@marea/protocol";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import type { OpenStoredRunInput } from "../../sessions/contracts.js";
import { governanceFixture, seedGovernancePilot } from "./governance-repository.fixture.js";
import { SqliteRunClosureRepository } from "./sqlite-run-closure-repository.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

export const CLOSURE_OPENED = "2026-09-12T10:00:00.000Z";
export const CLOSURE_NOW = "2026-09-12T12:00:00.000Z";

function student(userId: string, classId = "class:a"): AuthenticatedIdentity {
  return { classId, displayName: "Person", role: "student", userId };
}

/** Two classes with a teacher each and runs opened at 10:00, on the schema that records closers. */
export function closureClassroom() {
  const f = governanceFixture(undefined, "run-closure");
  seedGovernancePilot(f);
  for (const [userId, role, classId] of [
    ["user:alice", "student", "class:a"],
    ["user:bob", "student", "class:a"],
    ["user:cara", "student", "class:a"],
    ["user:dave", "student", "class:second"],
    ["user:teacher", "teacher", "class:a"],
    ["user:other-teacher", "teacher", "class:second"],
  ] as const) {
    f.createAccount("center:a", userId, role, classId);
    f.activate("center:a", userId);
  }
  const runs = new SqliteRunSessionRepository(f.database);
  const closures = new SqliteRunClosureRepository(f.database);
  const open = (
    userId: string,
    classId = "class:a",
    openedAt = CLOSURE_OPENED,
    overrides: Partial<OpenStoredRunInput> = {},
  ) => {
    const name = userId.replace("user:", "");
    runs.openRun({
      activatedEventId: `event:${name}:activated`,
      clientSessionId: `client:${name}`,
      expiresAt: new Date(Date.parse(openedAt) + 600_000).toISOString(),
      fingerprint: `fingerprint:${name}`,
      idempotencyKey: `open:${name}`,
      intent: { kind: "new" },
      issuedAt: openedAt,
      leaseId: `lease:${name}:opened`,
      leaseTokenHash: `lease:${name}:opened`,
      openedAt,
      projectDisplayName: "Lab",
      proposedRunId: `run:${name}`,
      requestId: `request:${name}:open`,
      captureSnapshot: () => ({
        providerRoute: { model: "model", providerId: "provider" },
        snapshot: StudentRunSnapshotSchema.parse({
          id: `snapshot:${name}`,
          modelAlias: "marea",
          teacherToolPolicy: { version: "v1", restrictions: [] },
          prompt: { version: "v1", content: "Ask.", digest: `sha256:${"b".repeat(64)}` },
          didacticSkills: [],
          agentMode: "tutoring",
        }),
      }),
      student: student(userId, classId),
      ...overrides,
    });
    return `run:${name}`;
  };
  const signIn = (token: string, userId: string, issuedAt: string, expiresAt: string) => {
    const session = { userId, issuedAt, expiresAt };
    f.identities.createSession({
      ...session,
      tokenHash: token,
      sessionId: `session:${token}`,
      classId: "class:a",
    });
  };
  const run = (runId: string) =>
    f.database.readOne(
      "SELECT state, closed_at, close_reason, closed_by FROM marea_runs WHERE id = ?1",
      [runId],
    );
  const events = (runId: string) =>
    f.database.readAll(
      "SELECT sequence, event_type, payload_json FROM marea_run_events WHERE run_id = ?1 ORDER BY sequence",
      [runId],
    );
  const touch = (runId: string, at: string) => {
    f.database.execute("UPDATE marea_active_runs SET last_activity_at = ?2 WHERE run_id = ?1", [
      runId,
      at,
    ]);
  };
  const expireLeases = (runId: string, at = CLOSURE_OPENED) => {
    f.database.execute("UPDATE marea_run_leases SET expires_at = ?2 WHERE run_id = ?1", [
      runId,
      at,
    ]);
  };
  let sequence = 0;
  const createEventId = () => `event:closure:${String(++sequence)}`;
  return { f, runs, closures, open, signIn, run, events, touch, expireLeases, createEventId };
}
