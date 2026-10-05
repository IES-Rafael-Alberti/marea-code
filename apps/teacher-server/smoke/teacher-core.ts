import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  ActiveRunDashboardQuerySchema,
  AppendRunEventsRequestSchema,
  ClassBootstrapRequestSchema,
  CredentialLoginRequestSchema,
  EnrollStudentRequestSchema,
  OpenRunRequestSchema,
  StudentRunSnapshotSchema,
} from "@marea/protocol";
import { initializeSqliteStorage } from "@marea/sqlite-storage";

import { ClassBootstrapService } from "../src/classes/index.js";
import { ActiveRunsService } from "../src/dashboard-api/index.js";
import type {
  Clock,
  IdGenerator,
  PasswordHasher,
  SecretDigest,
  SecretIssuer,
} from "../src/identity/index.js";
import { IdentityService, TeacherDomainError } from "../src/identity/index.js";
import {
  SqliteClassroomRepository,
  SqliteDashboardRepository,
  SqliteIdentityRepository,
  SqliteRunSessionRepository,
} from "../src/platform/persistence/index.js";
import type { RunSnapshotSource } from "../src/sessions/index.js";
import { RunSessionService } from "../src/sessions/index.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class StableValues implements Clock, IdGenerator, SecretIssuer {
  public current = "2026-09-03T10:00:00.000Z";
  #counter = 0;

  public createId(namespace: Parameters<IdGenerator["createId"]>[0]): string {
    this.#counter += 1;
    return `${namespace}:${String(this.#counter)}`;
  }

  public issue(): string {
    this.#counter += 1;
    return `secret_${String(this.#counter).padStart(40, "0")}`;
  }

  public now(): string {
    return this.current;
  }
}

const passwords: PasswordHasher = {
  hash(password): Promise<string> {
    return Promise.resolve(`argon2id:${password}`);
  },
  verify(password, passwordHash): Promise<boolean> {
    return Promise.resolve(passwordHash === `argon2id:${password}`);
  },
};

const digest: SecretDigest = {
  digest(secret): string {
    return `sha256:${secret}`;
  },
};

function expectDomainError(operation: () => void, code: TeacherDomainError["code"]): void {
  try {
    operation();
  } catch (error) {
    assert(error instanceof TeacherDomainError && error.code === code, `Expected ${code}.`);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

async function main(): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), "marea-teacher-core-"));
  const storage = initializeSqliteStorage({ databasePath: resolve(directory, "teacher.sqlite") });
  try {
    const values = new StableValues();
    const identities = new SqliteIdentityRepository(storage.database);
    const identityService = new IdentityService({
      clock: values,
      digest,
      dummyPasswordHash: "argon2id:invalid-credential-padding",
      ids: values,
      passwords,
      repository: identities,
      secrets: values,
    });
    await identityService.bootstrap({
      accounts: [
        {
          classKey: "physics",
          displayName: "Teacher Ada",
          login: "ADA",
          password: "teacher-password",
          role: "teacher",
        },
        {
          classKey: "physics",
          displayName: "Student Bob",
          login: "BOB",
          password: "student-password",
          role: "student",
        },
        {
          classKey: "history",
          displayName: "Teacher Grace",
          login: "GRACE",
          password: "teacher-password",
          role: "teacher",
        },
      ],
      classes: [
        { displayName: "Physics", key: "physics" },
        { displayName: "History", key: "history" },
      ],
      invitations: [{ classKey: "physics", code: "invite_alice_2026" }],
      seedId: "pilot-fixtures-v1",
    });
    assert(
      !(await identityService.bootstrap({
        accounts: [],
        classes: [],
        invitations: [],
        seedId: "pilot-fixtures-v1",
      })),
      "The fixture seed was applied more than once.",
    );

    const enrollmentRequest = EnrollStudentRequestSchema.parse({
      credentials: { login: "alice", password: "student-password" },
      displayName: "Student Alice",
      invitationCode: "invite_alice_2026",
      kind: "student-invitation-enrollment",
      protocolVersion: "0.1",
      requestId: "request:enroll",
    });
    const enrollment = await identityService.enroll(enrollmentRequest);
    await expectDomainErrorAsync(
      () =>
        identityService.enroll(
          EnrollStudentRequestSchema.parse({
            ...enrollmentRequest,
            requestId: "request:replay",
          }),
        ),
      "invitation.unavailable",
    );

    const alice = identityService.authenticate(enrollment.session.token).identity;
    const bob = await login(identityService, "bob", "student-password", "request:bob");
    const teacher = await login(identityService, "ada", "teacher-password", "request:teacher");
    const otherTeacher = await login(
      identityService,
      "grace",
      "teacher-password",
      "request:other-teacher",
    );
    await expectDomainErrorAsync(
      () => login(identityService, "missing", "student-password", "request:missing"),
      "auth.invalid",
    );
    await expectDomainErrorAsync(
      () => login(identityService, "alice", "wrong-password", "request:wrong"),
      "auth.invalid",
    );

    const classroomService = new ClassBootstrapService(
      new SqliteClassroomRepository(storage.database),
    );
    const bootstrap = classroomService.load(
      alice,
      ClassBootstrapRequestSchema.parse({
        kind: "class-bootstrap",
        protocolVersion: "0.1",
        requestId: "request:bootstrap",
      }),
    );
    assert(
      bootstrap.kind === "class-bootstrapped" && bootstrap.classroom.displayName === "Physics",
      "Bootstrap crossed class authority.",
    );

    let promptVersion = "prompt-v1";
    const snapshots: RunSnapshotSource = {
      capture(snapshotId) {
        return {
          providerRoute: { model: "upstream-model", providerId: "openrouter" },
          snapshot: StudentRunSnapshotSchema.parse({
            agentMode: "tutoring",
            didacticSkills: [],
            id: snapshotId,
            modelAlias: "marea",
            prompt: {
              content: `Prompt ${promptVersion}`,
              digest: `sha256:${"a".repeat(64)}`,
              version: promptVersion,
            },
            teacherToolPolicy: { restrictions: [], version: "policy-v1" },
          }),
        };
      },
    };
    const runs = new RunSessionService({
      clock: values,
      digest,
      ids: values,
      repository: new SqliteRunSessionRepository(storage.database),
      secrets: values,
      snapshots,
    });
    const openRequest = OpenRunRequestSchema.parse({
      clientSessionId: "client:alice",
      clientVersion: "0.1.0",
      idempotencyKey: "open:alice:physics",
      intent: { kind: "new" },
      project: { displayName: "Wave lab" },
      protocolVersion: "0.1",
      requestId: "request:open",
    });
    const opened = runs.open(alice, openRequest);
    promptVersion = "prompt-v2";
    const retried = runs.open(
      alice,
      OpenRunRequestSchema.parse({ ...openRequest, requestId: "request:open-retry" }),
    );
    assert(opened.lease.runId === retried.lease.runId, "Open retry duplicated the run.");
    assert(opened.snapshot.prompt.version === "prompt-v1", "The snapshot was not immutable.");
    expectDomainError(() => appendStudentMessage(runs, opened.lease.token, 2), "run.unavailable");
    const acknowledged = appendStudentMessage(runs, retried.lease.token, 2);
    assert(acknowledged === 2, "The canonical event was not durably acknowledged.");
    assert(
      appendStudentMessage(runs, retried.lease.token, 2) === 2,
      "The event retry was not idempotent.",
    );
    expectDomainError(
      () =>
        runs.append(
          retried.lease.token,
          AppendRunEventsRequestSchema.parse({
            events: [
              {
                content: "Changed duplicate",
                eventId: "event:student-message",
                eventType: "student-message",
                occurredAt: "2026-09-03T10:01:00.000Z",
                sequence: 2,
              },
            ],
            kind: "run-events-append",
            protocolVersion: "0.1",
            requestId: "request:conflicting-event",
          }),
        ),
      "request.conflict",
    );

    const dashboard = new ActiveRunsService(
      new SqliteDashboardRepository(storage.database),
      values,
    );
    const query = ActiveRunDashboardQuerySchema.parse({
      kind: "active-runs-query",
      limit: 10,
      protocolVersion: "0.1",
      requestId: "request:dashboard",
    });
    const approval = AppendRunEventsRequestSchema.parse({
      events: [
        {
          approvalId: "approval:edit",
          eventId: "event:approval-requested",
          eventType: "approval-requested",
          occurredAt: "2026-09-03T10:02:00.000Z",
          sequence: 3,
          summary: "Update the project file",
          tool: "workspace.write",
        },
      ],
      kind: "run-events-append",
      protocolVersion: "0.1",
      requestId: "request:approval",
    });
    runs.append(retried.lease.token, approval);
    const pendingRun = dashboard.query({ identity: teacher }, query).runs[0];
    assert(
      pendingRun?.highestDurableSequence === 3 && pendingRun.pendingApproval,
      "The dashboard projection preceded the durable approval event.",
    );
    runs.append(
      retried.lease.token,
      AppendRunEventsRequestSchema.parse({
        events: [
          {
            approvalId: "approval:edit",
            decision: "approved",
            eventId: "event:approval-resolved",
            eventType: "approval-resolved",
            occurredAt: "2026-09-03T10:03:00.000Z",
            sequence: 4,
          },
        ],
        kind: "run-events-append",
        protocolVersion: "0.1",
        requestId: "request:approval-resolved",
      }),
    );
    const resolvedRun = dashboard.query({ identity: teacher }, query).runs[0];
    assert(
      resolvedRun?.highestDurableSequence === 4 && !resolvedRun.pendingApproval,
      "The resolved approval projection is not durable.",
    );
    assert(
      dashboard.query({ identity: otherTeacher }, query).runs.length === 0,
      "The dashboard crossed teacher class authority.",
    );
    expectDomainError(
      () => appendStudentMessage(runs, "invalid-lease-token", 5),
      "run.unavailable",
    );

    values.current = "2026-09-03T10:04:00.000Z";
    const bobRun = runs.open(
      bob,
      OpenRunRequestSchema.parse({
        ...openRequest,
        clientSessionId: "client:bob",
        idempotencyKey: "open:bob:physics",
        project: { displayName: "Later project" },
        requestId: "request:open-bob",
      }),
    );
    const ordered = dashboard.query({ identity: teacher }, query).runs;
    assert(
      ordered[0]?.runId === bobRun.lease.runId && ordered[1]?.runId === retried.lease.runId,
      "The dashboard ordering is not deterministic by latest activity.",
    );
    const firstPage = dashboard.query(
      { identity: teacher },
      ActiveRunDashboardQuerySchema.parse({ ...query, cursor: undefined, limit: 1 }),
    );
    assert(firstPage.nextCursor !== null, "The dashboard did not return a pagination cursor.");
    const secondPage = dashboard.query(
      { identity: teacher },
      ActiveRunDashboardQuerySchema.parse({ ...query, cursor: firstPage.nextCursor, limit: 1 }),
    );
    assert(
      secondPage.runs[0]?.runId === retried.lease.runId,
      "Dashboard pagination reordered runs.",
    );

    const resumed = runs.open(
      alice,
      OpenRunRequestSchema.parse({
        ...openRequest,
        idempotencyKey: "resume:alice:physics",
        intent: { kind: "resume" },
        requestId: "request:resume",
      }),
    );
    assert(resumed.lease.runId === opened.lease.runId, "Resume selected a different run.");
    const closed = runs.close(resumed.lease.token, "request:close", "student-exit");
    assert(!closed.alreadyClosed, "The first close was reported as a retry.");
    assert(
      runs.close(resumed.lease.token, "request:close-retry", "student-exit").alreadyClosed,
      "Repeated close was not idempotent.",
    );
    expectDomainError(
      () =>
        runs.open(
          alice,
          OpenRunRequestSchema.parse({
            ...openRequest,
            idempotencyKey: "resume:closed",
            intent: { kind: "resume" },
            requestId: "request:resume-closed",
          }),
        ),
      "run.unavailable",
    );
    const finalRuns = dashboard.query({ identity: teacher }, query).runs;
    assert(
      finalRuns.every((run) => run.runId !== closed.runId),
      "Closed run remained active.",
    );

    const logout = identityService.logout(enrollment.session.token, "request:logout");
    assert(!logout.alreadyLoggedOut, "The first logout was reported as a retry.");
    assert(
      identityService.logout(enrollment.session.token, "request:logout-retry").alreadyLoggedOut,
      "Repeated logout was not idempotent.",
    );
    expectDomainError(() => identityService.authenticate(enrollment.session.token), "auth.invalid");
    assert(
      storage.database.readOne("SELECT token_hash FROM marea_auth_sessions WHERE token_hash = ?1", [
        enrollment.session.token,
      ]) === undefined,
      "A plaintext session token was stored.",
    );
    process.stdout.write("teacher core smoke test passed.\n");
  } finally {
    storage.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

async function login(
  service: IdentityService,
  loginName: string,
  password: string,
  requestId: string,
) {
  const response = await service.login(
    CredentialLoginRequestSchema.parse({
      credentials: { login: loginName, password },
      kind: "credential-login",
      protocolVersion: "0.1",
      requestId,
    }),
  );
  return service.authenticate(response.session.token).identity;
}

async function expectDomainErrorAsync(
  operation: () => Promise<object>,
  code: TeacherDomainError["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof TeacherDomainError && error.code === code, `Expected ${code}.`);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

function appendStudentMessage(
  service: RunSessionService,
  leaseToken: string,
  sequence: number,
): number {
  const response = service.append(
    leaseToken,
    AppendRunEventsRequestSchema.parse({
      events: [
        {
          content: "Hello",
          eventId: "event:student-message",
          eventType: "student-message",
          occurredAt: "2026-09-03T10:01:00.000Z",
          sequence,
        },
      ],
      kind: "run-events-append",
      protocolVersion: "0.1",
      requestId: `request:append:${String(sequence)}`,
    }),
  );
  return response.highestDurableSequence;
}

await main();
