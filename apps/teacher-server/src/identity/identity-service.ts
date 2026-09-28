import {
  CURRENT_PROTOCOL_VERSION,
  CredentialLoginResponseSchema,
  CredentialLogoutResponseSchema,
  EnrollStudentResponseSchema,
  type CredentialLoginRequest,
  type CredentialLoginResponse,
  type CredentialLogoutResponse,
  type EnrollStudentRequest,
  type EnrollStudentResponse,
  type SafePrincipal,
} from "@marea/protocol";

import type {
  AuthenticatedIdentity,
  AuthenticatedSession,
  Clock,
  IdGenerator,
  IdentityBootstrap,
  IdentityRepository,
  PasswordHasher,
  PreparedIdentityBootstrap,
  SecretDigest,
  SecretIssuer,
} from "./contracts.js";
import { TeacherDomainError } from "./errors.js";
import { PasswordAdmission } from "./password-admission.js";

const SESSION_DURATION_MS = 30 * 60 * 1_000;

export interface IdentityServiceDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly passwords: PasswordHasher;
  readonly repository: IdentityRepository;
  readonly secrets: SecretIssuer;
  readonly digest: SecretDigest;
  readonly dummyPasswordHash: string;
}

function normalizeLogin(login: string): string {
  return login.trim().toLocaleLowerCase("en-US");
}

function expiresAt(issuedAt: string): string {
  return new Date(Date.parse(issuedAt) + SESSION_DURATION_MS).toISOString();
}

function safePrincipal(identity: AuthenticatedIdentity): SafePrincipal {
  return { displayName: identity.displayName, role: identity.role };
}

export class IdentityService {
  readonly #dependencies: IdentityServiceDependencies;
  readonly #passwordAdmission = new PasswordAdmission();

  public constructor(dependencies: IdentityServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async bootstrap(seed: IdentityBootstrap): Promise<boolean> {
    const accounts = await Promise.all(
      seed.accounts.map(async (account) => ({
        classKey: account.classKey,
        displayName: account.displayName,
        login: normalizeLogin(account.login),
        passwordHash: await this.#dependencies.passwords.hash(account.password),
        role: account.role,
        userId: this.#dependencies.ids.createId("user"),
      })),
    );
    const prepared: PreparedIdentityBootstrap = {
      accounts,
      classes: seed.classes.map((classroom) => ({
        ...classroom,
        classId: this.#dependencies.ids.createId("class"),
      })),
      invitations: seed.invitations.map((invitation) => ({
        classKey: invitation.classKey,
        codeHash: this.#dependencies.digest.digest(invitation.code),
      })),
      seedId: seed.seedId,
    };
    return this.#dependencies.repository.applyBootstrap(prepared, this.#dependencies.clock.now());
  }

  public enroll(request: EnrollStudentRequest): Promise<EnrollStudentResponse> {
    return this.#passwordAdmission.run(() => this.enrollAdmitted(request));
  }

  private async enrollAdmitted(request: EnrollStudentRequest): Promise<EnrollStudentResponse> {
    const passwordHash = await this.#dependencies.passwords.hash(request.credentials.password);
    const result = this.#dependencies.repository.consumeInvitation({
      codeHash: this.#dependencies.digest.digest(request.invitationCode),
      displayName: request.displayName,
      enrolledAt: this.#dependencies.clock.now(),
      login: normalizeLogin(request.credentials.login),
      passwordHash,
      userId: this.#dependencies.ids.createId("user"),
    });
    if (!result.enrolled) {
      throw new TeacherDomainError("invitation.unavailable");
    }
    const session = this.createSession(result.identity, passwordHash);
    return EnrollStudentResponseSchema.parse({
      kind: "student-invitation-enrolled",
      principal: safePrincipal(result.identity),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      session,
    });
  }

  public login(request: CredentialLoginRequest): Promise<CredentialLoginResponse> {
    return this.#passwordAdmission.run(() => this.loginAdmitted(request));
  }

  private async loginAdmitted(request: CredentialLoginRequest): Promise<CredentialLoginResponse> {
    const credential = this.#dependencies.repository.findCredential(
      normalizeLogin(request.credentials.login),
    );
    const valid = await this.#dependencies.passwords.verify(
      request.credentials.password,
      credential?.passwordHash ?? this.#dependencies.dummyPasswordHash,
    );
    if (credential === undefined || !valid) {
      throw new TeacherDomainError("auth.invalid");
    }
    return CredentialLoginResponseSchema.parse({
      kind: "credential-authenticated",
      principal: safePrincipal(credential),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      session: this.createSession(credential, credential.passwordHash),
    });
  }

  public authenticate(token: string): AuthenticatedSession {
    const identity = this.#dependencies.repository.resolveSession(
      this.#dependencies.digest.digest(token),
      this.#dependencies.clock.now(),
    );
    if (identity === undefined) {
      throw new TeacherDomainError("auth.invalid");
    }
    return { identity, principal: safePrincipal(identity) };
  }

  public logout(token: string, requestId: string): CredentialLogoutResponse {
    const loggedOutAt = this.#dependencies.clock.now();
    const revoked = this.#dependencies.repository.revokeSession(
      this.#dependencies.digest.digest(token),
      loggedOutAt,
    );
    return CredentialLogoutResponseSchema.parse({
      alreadyLoggedOut: !revoked,
      kind: "credential-logged-out",
      loggedOutAt,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId,
    });
  }

  private createSession(
    identity: AuthenticatedIdentity,
    expectedPasswordHash: string,
  ): {
    readonly expiresAt: string;
    readonly issuedAt: string;
    readonly token: string;
  } {
    const issuedAt = this.#dependencies.clock.now();
    const token = this.#dependencies.secrets.issue();
    const session = { expiresAt: expiresAt(issuedAt), issuedAt, token };
    this.#dependencies.repository.createSession({
      ...session,
      sessionId: this.#dependencies.ids.createId("session"),
      tokenHash: this.#dependencies.digest.digest(token),
      userId: identity.userId,
      expectedPasswordHash,
    });
    return session;
  }
}
