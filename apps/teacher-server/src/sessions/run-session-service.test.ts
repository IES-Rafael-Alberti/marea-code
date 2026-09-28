import { createHash } from "node:crypto";

import {
  AppendRunEventsRequestSchema,
  CloseRunRequestSchema,
  OpenRunRequestSchema,
  RenewRunLeaseRequestSchema,
  StudentRunSnapshotSchema,
} from "@marea/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type {
  AppendEventsInput,
  AuthorizeRunLeaseInput,
  CloseAuthenticatedRunInput,
  CloseStoredRunInput,
  OpenStoredRunInput,
  RenewStoredLeaseInput,
  RunSessionRepository,
} from "./contracts.js";
import { RunSessionService, type RunSessionServiceDependencies } from "./run-session-service.js";

const STUDENT: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Student Alice",
  role: "student",
  userId: "user:alice",
};
const SNAPSHOT = StudentRunSnapshotSchema.parse({
  agentMode: "tutoring",
  didacticSkills: [],
  id: "snapshot:stored",
  modelAlias: "marea",
  prompt: {
    content: "Teach by asking questions.",
    digest: `sha256:${"a".repeat(64)}`,
    version: "prompt-v1",
  },
  teacherToolPolicy: { restrictions: [], version: "policy-v1" },
});
const OPEN = OpenRunRequestSchema.parse({
  clientSessionId: "client:alice",
  clientVersion: "0.1.0",
  idempotencyKey: "open:alice",
  intent: { kind: "new" },
  project: { displayName: "Wave lab" },
  protocolVersion: "0.1",
  requestId: "request:open",
});
const APPEND = AppendRunEventsRequestSchema.parse({
  events: [
    {
      content: "Hello",
      eventId: "event:message",
      eventType: "student-message",
      occurredAt: "2026-09-03T10:01:00.000Z",
      sequence: 2,
    },
  ],
  kind: "run-events-append",
  protocolVersion: "0.1",
  requestId: "request:append",
});

class RunSessionRepositoryFake implements RunSessionRepository {
  public appendInput: AppendEventsInput | undefined;
  public authorizeInput: AuthorizeRunLeaseInput | undefined;
  public closeAuthenticatedInput: CloseAuthenticatedRunInput | undefined;
  public closeInput: CloseStoredRunInput | undefined;
  public closeResult = { alreadyClosed: false, runId: "run:stored" };
  public openInput: OpenStoredRunInput | undefined;
  public renewInput: RenewStoredLeaseInput | undefined;

  public appendEvents(input: AppendEventsInput): number {
    this.appendInput = input;
    return 2;
  }

  public authorizeLease(input: AuthorizeRunLeaseInput) {
    this.authorizeInput = input;
    return {
      providerRoute: { model: "model", providerId: "openrouter" },
      runId: "run:stored",
      studentId: "user:1",
    };
  }

  public closeRun(input: CloseStoredRunInput) {
    this.closeInput = input;
    return this.closeResult;
  }

  public closeRunAuthenticated(input: CloseAuthenticatedRunInput) {
    this.closeAuthenticatedInput = input;
    return this.closeResult;
  }

  public openRun(input: OpenStoredRunInput) {
    this.openInput = input;
    return { highestDurableSequence: 7, runId: "run:stored", snapshot: SNAPSHOT };
  }

  public renewLease(input: RenewStoredLeaseInput) {
    this.renewInput = input;
    return { expiresAt: input.expiresAt, issuedAt: input.issuedAt, runId: input.runId };
  }
}

describe("run session service", () => {
  let repository: RunSessionRepositoryFake;
  let dependencies: RunSessionServiceDependencies;
  let sequence: number;

  beforeEach(() => {
    sequence = 0;
    repository = new RunSessionRepositoryFake();
    dependencies = {
      clock: { now: () => "2026-09-03T10:00:00.000Z" },
      digest: { digest: (secret) => `digest:${secret}` },
      ids: {
        createId: (namespace) => {
          sequence += 1;
          return `${namespace}:${String(sequence)}`;
        },
      },
      repository,
      secrets: { issue: () => "t".repeat(40) },
      snapshots: {
        capture: (snapshotId) => ({
          providerRoute: { model: "model", providerId: "openrouter" },
          snapshot: StudentRunSnapshotSchema.parse({ ...SNAPSHOT, id: snapshotId }),
        }),
      },
    };
  });

  it("opens through an immutable capture and returns a short scoped lease", () => {
    const response = new RunSessionService(dependencies).open(STUDENT, OPEN);

    expect(response).toMatchObject({
      lease: {
        expiresAt: "2026-09-03T10:10:00.000Z",
        issuedAt: "2026-09-03T10:00:00.000Z",
        runId: "run:stored",
        token: "t".repeat(40),
      },
      highestDurableSequence: 7,
      snapshot: SNAPSHOT,
    });
    expect(repository.openInput?.fingerprint).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            clientSessionId: OPEN.clientSessionId,
            intent: OPEN.intent,
            project: OPEN.project,
          }),
        )
        .digest("hex"),
    );
    expect(repository.openInput?.activatedEventId).toBe("event:2");
    expect(repository.openInput?.leaseId).toBe("lease:3");
    expect(repository.openInput?.proposedRunId).toBe("run:4");
    expect(repository.openInput?.leaseTokenHash).toBe(`digest:${"t".repeat(40)}`);
    expect(repository.openInput?.student).toBe(STUDENT);
    expect(repository.openInput).not.toHaveProperty("resumeRunId");
    expect(repository.openInput?.captureSnapshot()).toEqual({
      providerRoute: { model: "model", providerId: "openrouter" },
      snapshot: { ...SNAPSHOT, id: "snapshot:1" },
    });
  });

  it("forwards and verifies the explicit run identity on resume", () => {
    const resume = OpenRunRequestSchema.parse({
      ...OPEN,
      idempotencyKey: "resume:alice",
      intent: { kind: "resume" },
      runId: "run:stored",
    });
    const service = new RunSessionService(dependencies);

    expect(service.open(STUDENT, resume).lease.runId).toBe("run:stored");
    expect(repository.openInput?.resumeRunId).toBe("run:stored");

    repository.openRun = () => ({
      highestDurableSequence: 7,
      runId: "run:foreign",
      snapshot: SNAPSHOT,
    });
    expect(() => service.open(STUDENT, resume)).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
  });

  it("appends acknowledged canonical events and closes idempotently as reported", () => {
    const service = new RunSessionService(dependencies);
    expect(service.append("lease", APPEND).highestDurableSequence).toBe(2);
    expect(repository.appendInput).toEqual(
      expect.objectContaining({ leaseTokenHash: "digest:lease" }),
    );

    expect(service.close("lease", "request:close", "student-exit").alreadyClosed).toBe(false);
    expect(repository.closeInput).toEqual({
      closedAt: "2026-09-03T10:00:00.000Z",
      closingEventId: "event:1",
      leaseTokenHash: "digest:lease",
      reason: "student-exit",
    });
    repository.closeResult = { alreadyClosed: true, runId: "run:stored" };
    expect(service.close("lease", "request:close-2", "student-exit").alreadyClosed).toBe(true);
  });

  it("authorizes model access from only the purpose-scoped raw lease", () => {
    const service = new RunSessionService(dependencies);
    expect(service.authorizeLease("lease")).toEqual({
      providerRoute: { model: "model", providerId: "openrouter" },
      runId: "run:stored",
      studentId: "user:1",
    });
    expect(repository.authorizeInput).toEqual({
      leaseTokenHash: "digest:lease",
      now: "2026-09-03T10:00:00.000Z",
    });
  });

  it("recovers a lease and closes by explicit run identity through student authentication", () => {
    const service = new RunSessionService(dependencies);
    const renewal = RenewRunLeaseRequestSchema.parse({
      kind: "run-lease-renewal",
      protocolVersion: "0.1",
      requestId: "request:renew",
      runId: "run:stored",
    });

    expect(service.renew(STUDENT, renewal)).toMatchObject({
      kind: "run-lease-renewed",
      lease: {
        expiresAt: "2026-09-03T10:10:00.000Z",
        issuedAt: "2026-09-03T10:00:00.000Z",
        runId: "run:stored",
        token: "t".repeat(40),
      },
      requestId: "request:renew",
    });
    expect(repository.renewInput).toEqual({
      expiresAt: "2026-09-03T10:10:00.000Z",
      issuedAt: "2026-09-03T10:00:00.000Z",
      leaseId: "lease:1",
      leaseTokenHash: `digest:${"t".repeat(40)}`,
      runId: "run:stored",
      studentId: "user:alice",
    });

    const close = CloseRunRequestSchema.parse({
      protocolVersion: "0.1",
      reason: "student-exit",
      requestId: "request:close-authenticated",
      runId: "run:stored",
    });
    expect(service.closeAuthenticated(STUDENT, close).alreadyClosed).toBe(false);
    expect(repository.closeAuthenticatedInput).toEqual({
      closedAt: "2026-09-03T10:00:00.000Z",
      closingEventId: "event:2",
      reason: "student-exit",
      runId: "run:stored",
      studentId: "user:alice",
    });
  });

  it("rejects opening a run for a non-student principal", () => {
    const service = new RunSessionService(dependencies);
    for (const identity of [
      { ...STUDENT, role: "teacher" as const },
      { ...STUDENT, classId: null },
    ]) {
      expect(() => service.open(identity, OPEN)).toThrow(
        expect.objectContaining({ code: "run.unavailable" }),
      );
    }
  });

  it("rejects lease recovery and authenticated close for non-students", () => {
    const service = new RunSessionService(dependencies);
    const renewal = RenewRunLeaseRequestSchema.parse({
      kind: "run-lease-renewal",
      protocolVersion: "0.1",
      requestId: "request:renew",
      runId: "run:stored",
    });
    const close = CloseRunRequestSchema.parse({
      protocolVersion: "0.1",
      reason: "student-exit",
      requestId: "request:close",
      runId: "run:stored",
    });
    for (const identity of [
      { ...STUDENT, role: "teacher" as const },
      { ...STUDENT, classId: null },
    ]) {
      expect(() => service.renew(identity, renewal)).toThrow(
        expect.objectContaining({ code: "run.unavailable" }),
      );
      expect(() => service.closeAuthenticated(identity, close)).toThrow(
        expect.objectContaining({ code: "run.unavailable" }),
      );
    }
  });

  it("rejects ambiguous identities returned by lease recovery and authenticated close", () => {
    const service = new RunSessionService(dependencies);
    const renewal = RenewRunLeaseRequestSchema.parse({
      kind: "run-lease-renewal",
      protocolVersion: "0.1",
      requestId: "request:renew",
      runId: "run:stored",
    });
    repository.renewLease = (input) => ({
      expiresAt: input.expiresAt,
      issuedAt: input.issuedAt,
      runId: "run:foreign",
    });
    expect(() => service.renew(STUDENT, renewal)).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );

    const legacyClose = CloseRunRequestSchema.parse({
      protocolVersion: "0.1",
      reason: "student-exit",
      requestId: "request:legacy-close",
    });
    expect(() => service.closeAuthenticated(STUDENT, legacyClose)).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
    expect(repository.closeAuthenticatedInput).toBeUndefined();

    const close = CloseRunRequestSchema.parse({
      ...legacyClose,
      requestId: "request:close",
      runId: "run:stored",
    });
    repository.closeRunAuthenticated = () => ({
      alreadyClosed: false,
      runId: "run:foreign",
    });
    expect(() => service.closeAuthenticated(STUDENT, close)).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
  });

  it("validates lease recovery requests before consulting persistence", () => {
    const service = new RunSessionService(dependencies);
    const renewal = RenewRunLeaseRequestSchema.parse({
      kind: "run-lease-renewal",
      protocolVersion: "0.1",
      requestId: "request:renew",
      runId: "run:stored",
    });
    expect(() => service.renew(STUDENT, { ...renewal, unexpected: true } as never)).toThrow();
    expect(repository.renewInput).toBeUndefined();

    const close = CloseRunRequestSchema.parse({
      protocolVersion: "0.1",
      reason: "student-exit",
      requestId: "request:close",
      runId: "run:stored",
    });
    expect(() =>
      service.closeAuthenticated(STUDENT, {
        ...close,
        unexpected: true,
      } as never),
    ).toThrow();
    expect(repository.closeAuthenticatedInput).toBeUndefined();
  });
});
