import type { PrincipalRole } from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import type {
  AuthenticatedIdentity,
  EnrollmentResult,
  IdentityRepository,
  PreparedIdentityBootstrap,
  StoredCredential,
  StudentClassChoice,
} from "../../identity/contracts.js";
import { rowNullableText, rowText } from "./row-parser.boundary.js";
import { activeGovernanceAccount, activeStudentClass } from "./governance-access-sql.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { projectNewGovernedIdentity } from "./governance-identity-projection.js";
import { hasClassScopedSessions, readStudentClasses } from "./student-classes.js";

const READ_CREDENTIAL = `SELECT id, password_hash, role, display_name, class_id
  FROM marea_users WHERE login = ?1 AND ${activeGovernanceAccount("marea_users.id")}`;
const LIVE_SESSION = `FROM marea_auth_sessions sessions
  JOIN marea_users users ON users.id = sessions.user_id
  WHERE sessions.token_hash = ?1 AND sessions.revoked_at IS NULL AND sessions.expires_at > ?2
    AND ${activeGovernanceAccount("users.id")}`;
const READ_SESSION = `SELECT users.id, users.role, users.display_name, users.class_id ${LIVE_SESSION}`;
/** A student session acts only for its own class, and only while the student may act for it. */
const READ_CLASS_SCOPED_SESSION = `SELECT users.id, users.role, users.display_name,
    CASE WHEN users.role = 'student' THEN sessions.class_id ELSE users.class_id END AS class_id
  ${LIVE_SESSION}
    AND (sessions.class_id IS NULL OR ${activeStudentClass("users.id", "sessions.class_id")})`;

function role(row: SqliteRow): PrincipalRole {
  const value = rowText(row, "role");
  if (value !== "student" && value !== "teacher") {
    throw new Error("Stored teacher data is invalid.");
  }
  return value;
}

function identity(row: SqliteRow): AuthenticatedIdentity {
  return {
    classId: rowNullableText(row, "class_id"),
    displayName: rowText(row, "display_name"),
    role: role(row),
    userId: rowText(row, "id"),
  };
}

export class SqliteIdentityRepository implements IdentityRepository {
  readonly #database: SqliteApplicationDatabase;
  #classScoped: boolean | undefined;

  public constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
  }

  /** Before schema 12 a student has one class, which its account row names. */
  private classScoped(): boolean {
    this.#classScoped ??= hasClassScopedSessions(this.#database);
    return this.#classScoped;
  }

  public applyBootstrap(seed: PreparedIdentityBootstrap, createdAt: string): boolean {
    return this.#database.transaction(() => {
      if (
        this.#database.readOne("SELECT seed_id FROM marea_bootstrap_markers WHERE seed_id = ?1", [
          seed.seedId,
        ]) !== undefined
      ) {
        return false;
      }
      for (const classroom of seed.classes) {
        this.#database.execute(
          "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
          [classroom.classId, classroom.key, classroom.displayName],
        );
      }
      for (const account of seed.accounts) {
        const classId = this.classId(account.classKey);
        this.#database.execute(
          `INSERT INTO marea_users
            (id, login, password_hash, role, display_name, class_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          [
            account.userId,
            account.login,
            account.passwordHash,
            account.role,
            account.displayName,
            classId,
          ],
        );
        if (account.role === "teacher" && classId !== null) {
          this.#database.execute(
            "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES (?1, ?2)",
            [account.userId, classId],
          );
        }
        projectNewGovernedIdentity(this.#database, account.userId, createdAt);
      }
      for (const invitation of seed.invitations) {
        this.#database.execute(
          "INSERT INTO marea_invitations (code_hash, class_id) VALUES (?1, ?2)",
          [invitation.codeHash, this.requiredClassId(invitation.classKey)],
        );
      }
      this.#database.execute(
        "INSERT INTO marea_bootstrap_markers (seed_id, created_at) VALUES (?1, ?2)",
        [seed.seedId, createdAt],
      );
      return true;
    });
  }

  public consumeInvitation(input: {
    readonly codeHash: string;
    readonly displayName: string;
    readonly enrolledAt: string;
    readonly login: string;
    readonly passwordHash: string;
    readonly userId: string;
  }): EnrollmentResult {
    return this.#database.transaction(() => {
      const invitation = this.#database.readOne(
        "SELECT class_id, consumed_at FROM marea_invitations WHERE code_hash = ?1",
        [input.codeHash],
      );
      const login = this.#database.readOne("SELECT id FROM marea_users WHERE login = ?1", [
        input.login,
      ]);
      if (
        invitation === undefined ||
        rowNullableText(invitation, "consumed_at") !== null ||
        login
      ) {
        return { enrolled: false };
      }
      const classId = rowText(invitation, "class_id");
      this.#database.execute(
        `INSERT INTO marea_users
          (id, login, password_hash, role, display_name, class_id)
          VALUES (?1, ?2, ?3, 'student', ?4, ?5)`,
        [input.userId, input.login, input.passwordHash, input.displayName, classId],
      );
      this.#database.execute(
        `UPDATE marea_invitations SET consumed_at = ?2, consumed_by = ?3
          WHERE code_hash = ?1`,
        [input.codeHash, input.enrolledAt, input.userId],
      );
      projectNewGovernedIdentity(this.#database, input.userId, input.enrolledAt);
      return {
        enrolled: true,
        identity: {
          classId,
          displayName: input.displayName,
          role: "student",
          userId: input.userId,
        },
      };
    });
  }

  public createSession(input: {
    readonly classId?: string | null;
    readonly expectedPasswordHash?: string;
    readonly expiresAt: string;
    readonly issuedAt: string;
    readonly sessionId: string;
    readonly tokenHash: string;
    readonly userId: string;
  }): void {
    this.#database.transaction(() => {
      const denied = this.#database.readOne(
        `SELECT user_id FROM marea_governance_accounts WHERE user_id = ?1 AND state <> 'active'
          UNION ALL SELECT id FROM marea_users WHERE id = ?1 AND ?2 IS NOT NULL AND password_hash <> ?2`,
        [input.userId, input.expectedPasswordHash ?? null],
      );
      if (denied !== undefined) throw new TeacherDomainError("auth.invalid");
      const values = [
        input.sessionId,
        input.userId,
        input.tokenHash,
        input.issuedAt,
        input.expiresAt,
      ];
      if (this.classScoped())
        this.#database.execute(
          `INSERT INTO marea_auth_sessions
          (id, user_id, token_hash, issued_at, expires_at, class_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          [...values, input.classId ?? null],
        );
      else
        this.#database.execute(
          `INSERT INTO marea_auth_sessions
          (id, user_id, token_hash, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
          values,
        );
    });
  }

  public findCredential(login: string): StoredCredential | undefined {
    const row = this.#database.readOne(READ_CREDENTIAL, [login]);
    return row === undefined
      ? undefined
      : { ...identity(row), passwordHash: rowText(row, "password_hash") };
  }

  public resolveSession(tokenHash: string, now: string): AuthenticatedIdentity | undefined {
    const row = this.#database.readOne(
      this.classScoped() ? READ_CLASS_SCOPED_SESSION : READ_SESSION,
      [tokenHash, now],
    );
    return row === undefined ? undefined : identity(row);
  }

  public selectSessionClass(
    tokenHash: string,
    classId: string,
    now: string,
  ): AuthenticatedIdentity | undefined {
    if (!this.classScoped()) return undefined;
    return this.#database.transaction(() => {
      const bound = this.#database.readAll(
        `UPDATE marea_auth_sessions SET class_id = ?3
          WHERE token_hash = ?1 AND class_id IS NULL AND revoked_at IS NULL AND expires_at > ?2
            AND EXISTS (SELECT 1 FROM marea_users users
              WHERE users.id = marea_auth_sessions.user_id AND users.role = 'student'
                AND ${activeStudentClass("users.id", "?3")})
          RETURNING id`,
        [tokenHash, now, classId],
      );
      return bound.length === 0 ? undefined : this.resolveSession(tokenHash, now);
    });
  }

  public studentClasses(userId: string): readonly StudentClassChoice[] {
    return readStudentClasses(this.#database, userId);
  }

  public revokeSession(tokenHash: string, revokedAt: string): boolean {
    return this.#database.transaction(() => {
      const active = this.#database.readOne(
        "SELECT id FROM marea_auth_sessions WHERE token_hash = ?1 AND revoked_at IS NULL",
        [tokenHash],
      );
      if (active === undefined) {
        return false;
      }
      this.#database.execute(
        "UPDATE marea_auth_sessions SET revoked_at = ?2 WHERE token_hash = ?1",
        [tokenHash, revokedAt],
      );
      return true;
    });
  }

  private classId(classKey: string | null): string | null {
    return classKey === null ? null : this.requiredClassId(classKey);
  }

  private requiredClassId(classKey: string): string {
    const row = this.#database.readOne("SELECT id FROM marea_classes WHERE seed_key = ?1", [
      classKey,
    ]);
    if (row === undefined) {
      throw new Error("Bootstrap class reference is invalid.");
    }
    return rowText(row, "id");
  }
}
