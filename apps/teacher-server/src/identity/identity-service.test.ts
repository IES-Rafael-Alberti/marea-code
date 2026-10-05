import {
  CredentialLoginRequestSchema,
  EnrollStudentRequestSchema,
  type PrincipalRole,
} from "@marea/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuthenticatedIdentity,
  EnrollmentResult,
  IdentityRepository,
  PreparedIdentityBootstrap,
  StoredCredential,
  StudentClassChoice,
} from "./contracts.js";
import { IdentityService, type IdentityServiceDependencies } from "./identity-service.js";

const STUDENT: AuthenticatedIdentity = {
  classId: "class:1",
  displayName: "Student Alice",
  role: "student",
  userId: "user:1",
};

class IdentityRepositoryFake implements IdentityRepository {
  public bootstrapApplied = true;
  public credential: StoredCredential | undefined = {
    ...STUDENT,
    passwordHash: "hash:correct-password",
  };
  public enrollment: EnrollmentResult = { enrolled: true, identity: STUDENT };
  public session: AuthenticatedIdentity | undefined = STUDENT;
  public revoked = true;
  public readonly sessions: object[] = [];
  public seed: PreparedIdentityBootstrap | undefined;
  public enrollmentInput: Parameters<IdentityRepository["consumeInvitation"]>[0] | undefined;
  public classes: readonly StudentClassChoice[] = [{ classId: "class:1", displayName: "One" }];
  public readonly classQueries: string[] = [];
  public selected: AuthenticatedIdentity | undefined = STUDENT;
  public readonly selections: (readonly string[])[] = [];

  public applyBootstrap(seed: PreparedIdentityBootstrap): boolean {
    this.seed = seed;
    return this.bootstrapApplied;
  }

  public consumeInvitation(
    input: Parameters<IdentityRepository["consumeInvitation"]>[0],
  ): EnrollmentResult {
    this.enrollmentInput = input;
    return this.enrollment;
  }

  public createSession(input: object): void {
    this.sessions.push(input);
  }

  public findCredential(): StoredCredential | undefined {
    return this.credential;
  }

  public resolveSession(): AuthenticatedIdentity | undefined {
    return this.session;
  }

  public revokeSession(): boolean {
    return this.revoked;
  }

  public selectSessionClass(
    tokenHash: string,
    classId: string,
    now: string,
  ): AuthenticatedIdentity | undefined {
    this.selections.push([tokenHash, classId, now]);
    return this.selected;
  }

  public studentClasses(userId: string): readonly StudentClassChoice[] {
    this.classQueries.push(userId);
    return this.classes;
  }
}

function request() {
  return CredentialLoginRequestSchema.parse({
    credentials: { login: "alice", password: "correct-password" },
    kind: "credential-login",
    protocolVersion: "0.1",
    requestId: "request:login",
  });
}

function enrollmentRequest() {
  return EnrollStudentRequestSchema.parse({
    credentials: { login: "alice", password: "correct-password" },
    displayName: "Student Alice",
    invitationCode: "invitation_12345",
    kind: "student-invitation-enrollment",
    protocolVersion: "0.1",
    requestId: "request:enroll",
  });
}

describe("identity service", () => {
  let repository: IdentityRepositoryFake;
  let verify: ReturnType<typeof vi.fn<(password: string, hash: string) => Promise<boolean>>>;
  let dependencies: IdentityServiceDependencies;

  beforeEach(() => {
    repository = new IdentityRepositoryFake();
    verify = vi.fn((password, hash) => Promise.resolve(hash === `hash:${password}`));
    let identifier = 0;
    dependencies = {
      clock: { now: () => "2026-09-03T10:00:00.000Z" },
      digest: { digest: (secret) => `digest:${secret}` },
      dummyPasswordHash: "hash:dummy",
      ids: {
        createId: (namespace) => {
          identifier += 1;
          return `${namespace}:${String(identifier)}`;
        },
      },
      passwords: { hash: (password) => Promise.resolve(`hash:${password}`), verify },
      repository,
      secrets: { issue: () => "s".repeat(40) },
    };
  });

  it("prepares and applies an explicit normalized bootstrap exactly as reported", async () => {
    const service = new IdentityService(dependencies);
    const seed = {
      accounts: [
        {
          classKey: "physics",
          displayName: "Teacher Ada",
          login: " ADA ",
          password: "teacher-password",
          role: "teacher" as PrincipalRole,
        },
      ],
      classes: [{ displayName: "Physics", key: "physics" }],
      invitations: [{ classKey: "physics", code: "invitation_12345" }],
      seedId: "fixtures-v1",
    };

    expect(await service.bootstrap(seed)).toBe(true);
    expect(repository.seed).toEqual({
      accounts: [
        {
          classKey: "physics",
          displayName: "Teacher Ada",
          login: "ada",
          passwordHash: "hash:teacher-password",
          role: "teacher",
          userId: "user:1",
        },
      ],
      classes: [{ classId: "class:2", displayName: "Physics", key: "physics" }],
      invitations: [{ classKey: "physics", codeHash: "digest:invitation_12345" }],
      seedId: "fixtures-v1",
    });
    repository.bootstrapApplied = false;
    expect(await service.bootstrap({ ...seed, accounts: [], classes: [], invitations: [] })).toBe(
      false,
    );
  });

  it("enrolls once, returns only a safe principal, and rejects an unavailable invitation", async () => {
    const service = new IdentityService(dependencies);
    const response = await service.enroll(enrollmentRequest());

    expect(response.principal).toEqual({ displayName: "Student Alice", role: "student" });
    expect(response.session.token).toBe("s".repeat(40));
    expect(response.session.expiresAt).toBe("2026-09-03T10:30:00.000Z");
    expect(repository.sessions).toEqual([expect.objectContaining({ classId: "class:1" })]);
    expect(repository.classQueries).toEqual([]);
    expect(repository.enrollmentInput).toEqual({
      codeHash: "digest:invitation_12345",
      displayName: "Student Alice",
      enrolledAt: "2026-09-03T10:00:00.000Z",
      login: "alice",
      passwordHash: "hash:correct-password",
      userId: "user:1",
    });

    repository.enrollment = { enrolled: false };
    await expect(service.enroll(enrollmentRequest())).rejects.toEqual(
      expect.objectContaining({ code: "invitation.unavailable" }),
    );
  });

  it("uses an indistinguishable error and one password verification for bad credentials", async () => {
    const service = new IdentityService(dependencies);
    repository.credential = undefined;
    dependencies = { ...dependencies, dummyPasswordHash: "hash:correct-password" };
    await expect(new IdentityService(dependencies).login(request())).rejects.toEqual(
      expect.objectContaining({ code: "auth.invalid", message: "auth.invalid" }),
    );
    expect(verify).toHaveBeenLastCalledWith("correct-password", "hash:correct-password");

    repository.credential = { ...STUDENT, passwordHash: "hash:different" };
    await expect(service.login(request())).rejects.toEqual(
      expect.objectContaining({ code: "auth.invalid", message: "auth.invalid" }),
    );
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("authenticates, creates a hashed short session, resolves it, and revokes it idempotently", async () => {
    const service = new IdentityService(dependencies);
    const response = await service.login(request());

    expect(response.principal).toEqual({ displayName: "Student Alice", role: "student" });
    expect(repository.sessions[0]).toEqual(
      expect.objectContaining({
        classId: "class:1",
        sessionId: "session:1",
        tokenHash: `digest:${"s".repeat(40)}`,
        userId: "user:1",
      }),
    );
    expect(repository.classQueries).toEqual(["user:1"]);
    expect(service.authenticate(response.session.token)).toEqual({
      identity: STUDENT,
      principal: { displayName: "Student Alice", role: "student" },
    });
    expect(service.logout(response.session.token, "request:logout").alreadyLoggedOut).toBe(false);
    repository.revoked = false;
    expect(service.logout(response.session.token, "request:logout-2").alreadyLoggedOut).toBe(true);
    repository.session = undefined;
    expect(() => service.authenticate(response.session.token)).toThrow(
      expect.objectContaining({ code: "auth.invalid", name: "TeacherDomainError" }),
    );
  });

  it("leaves a teacher or a student with several or no classes without a session class", async () => {
    const service = new IdentityService(dependencies);
    repository.classes = [
      { classId: "class:1", displayName: "One" },
      { classId: "class:2", displayName: "Two" },
    ];
    await service.login(request());
    repository.classes = [];
    await service.login(request());
    repository.credential = {
      ...STUDENT,
      role: "teacher",
      classId: "class:taught",
      passwordHash: "hash:correct-password",
    };
    await service.login(request());
    expect(
      repository.sessions.map((session) => (session as { classId: string | null }).classId),
    ).toEqual([null, null, null]);
    expect(repository.classQueries).toEqual(["user:1", "user:1"]);
  });

  it("binds a session to a chosen class or rejects an unavailable choice", () => {
    const service = new IdentityService(dependencies);
    expect(service.selectClass("token", "class:1")).toBe(STUDENT);
    expect(repository.selections).toEqual([
      ["digest:token", "class:1", "2026-09-03T10:00:00.000Z"],
    ]);
    repository.selected = undefined;
    expect(() => service.selectClass("token", "class:2")).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
  });

  it("opens an external session for a student with classes, binding a single one", () => {
    const service = new IdentityService(dependencies);
    expect(service.openExternalSession(STUDENT)).toEqual({
      principal: { displayName: "Student Alice", role: "student" },
      session: {
        expiresAt: "2026-09-03T10:30:00.000Z",
        issuedAt: "2026-09-03T10:00:00.000Z",
        token: "s".repeat(40),
      },
    });
    expect(repository.sessions[0]).toEqual({
      classId: "class:1",
      expiresAt: "2026-09-03T10:30:00.000Z",
      issuedAt: "2026-09-03T10:00:00.000Z",
      sessionId: "session:1",
      token: "s".repeat(40),
      tokenHash: `digest:${"s".repeat(40)}`,
      userId: "user:1",
    });
    expect(repository.sessions[0]).not.toHaveProperty("expectedPasswordHash");
    repository.classes = [
      { classId: "class:1", displayName: "One" },
      { classId: "class:2", displayName: "Two" },
    ];
    service.openExternalSession(STUDENT);
    expect(repository.sessions[1]).toMatchObject({ classId: null });
    repository.classes = [];
    expect(() => service.openExternalSession(STUDENT)).toThrow(
      expect.objectContaining({ code: "auth.invalid" }),
    );
    expect(repository.sessions).toHaveLength(2);
  });
});
