import type { PrincipalRole, SafePrincipal } from "@marea/protocol";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  createId(
    namespace: "class" | "event" | "lease" | "revision" | "run" | "session" | "snapshot" | "user",
  ): string;
}

export interface SecretDigest {
  digest(secret: string): string;
}

export interface SecretIssuer {
  issue(): string;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string): Promise<boolean>;
}

export interface AuthenticatedIdentity {
  readonly classId: string | null;
  readonly displayName: string;
  readonly role: PrincipalRole;
  readonly userId: string;
}

export interface StoredCredential extends AuthenticatedIdentity {
  readonly passwordHash: string;
}

export interface BootstrapAccount {
  readonly classKey: string | null;
  readonly displayName: string;
  readonly login: string;
  readonly password: string;
  readonly role: PrincipalRole;
}

export interface BootstrapClass {
  readonly displayName: string;
  readonly key: string;
}

export interface BootstrapInvitation {
  readonly classKey: string;
  readonly code: string;
}

export interface IdentityBootstrap {
  readonly accounts: readonly BootstrapAccount[];
  readonly classes: readonly BootstrapClass[];
  readonly invitations: readonly BootstrapInvitation[];
  readonly seedId: string;
}

interface PreparedBootstrapAccount extends Omit<BootstrapAccount, "password"> {
  readonly passwordHash: string;
  readonly userId: string;
}

export interface PreparedIdentityBootstrap extends Omit<
  IdentityBootstrap,
  "accounts" | "invitations"
> {
  readonly accounts: readonly PreparedBootstrapAccount[];
  readonly invitations: readonly {
    readonly classKey: string;
    readonly codeHash: string;
  }[];
  readonly classes: readonly (BootstrapClass & { readonly classId: string })[];
}

export type EnrollmentResult =
  | { readonly enrolled: false }
  | { readonly enrolled: true; readonly identity: AuthenticatedIdentity };

export interface IdentityRepository {
  applyBootstrap(seed: PreparedIdentityBootstrap, createdAt: string): boolean;
  consumeInvitation(input: {
    readonly codeHash: string;
    readonly displayName: string;
    readonly login: string;
    readonly passwordHash: string;
    readonly userId: string;
    readonly enrolledAt: string;
  }): EnrollmentResult;
  createSession(input: {
    /** The class a student session acts for; omitted or null for teachers and undecided students. */
    readonly classId?: string | null;
    readonly expectedPasswordHash?: string;
    readonly expiresAt: string;
    readonly issuedAt: string;
    readonly sessionId: string;
    readonly tokenHash: string;
    readonly userId: string;
  }): void;
  findCredential(login: string): StoredCredential | undefined;
  resolveSession(tokenHash: string, now: string): AuthenticatedIdentity | undefined;
  revokeSession(tokenHash: string, revokedAt: string): boolean;
  /** Binds a live student session that names no class yet to one of its active classes. */
  selectSessionClass(
    tokenHash: string,
    classId: string,
    now: string,
  ): AuthenticatedIdentity | undefined;
  studentClasses(userId: string): readonly StudentClassChoice[];
}

export interface StudentClassChoice {
  readonly classId: string;
  readonly displayName: string;
}

export interface AuthenticatedSession {
  readonly identity: AuthenticatedIdentity;
  readonly principal: SafePrincipal;
}
