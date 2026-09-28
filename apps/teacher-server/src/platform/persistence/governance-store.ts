import {
  GovernanceAccountSchema,
  GovernanceClassSchema,
  MembershipSchema,
  PrincipalRoleSchema,
  RevisionIdSchema,
  SafeDisplayNameSchema,
} from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";
import type {
  GovernanceCommitContext,
  GovernanceReadContext,
  Id,
  Time,
} from "../../governance/authority.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type { IdentityCreationGuard } from "./identity-creation-guard.js";
import { rowNullableText, rowText } from "./row-parser.boundary.js";

export function governanceConflict(): never {
  throw new TeacherDomainError("request.conflict");
}

export function governanceForbidden(): never {
  throw new TeacherDomainError("dashboard.forbidden");
}

/** Private persistence collaborator. Domain/application ports never receive SQL. */
export class GovernanceStore {
  constructor(
    readonly database: SqliteApplicationDatabase,
    private readonly operatorReady: (classId: Id) => boolean,
    readonly identities: IdentityCreationGuard,
  ) {}

  requireSession(sessionId: Id, userId: Id, now: Time): AuthenticatedIdentity {
    const row = this.database.readOne(
      `SELECT users.id, users.role, users.display_name, users.class_id
        FROM marea_auth_sessions sessions JOIN marea_users users ON users.id = sessions.user_id
        JOIN marea_governance_accounts accounts ON accounts.user_id = users.id
        WHERE sessions.id = ?1 AND users.id = ?2 AND sessions.revoked_at IS NULL
          AND sessions.expires_at > ?3 AND accounts.state = 'active'`,
      [sessionId, userId, now],
    );
    if (row === undefined) throw new TeacherDomainError("auth.invalid");
    return Object.freeze({
      userId: RevisionIdSchema.parse(rowText(row, "id")),
      displayName: SafeDisplayNameSchema.parse(rowText(row, "display_name")),
      role: PrincipalRoleSchema.parse(rowText(row, "role")),
      classId: RevisionIdSchema.nullable().parse(rowNullableText(row, "class_id")),
    });
  }

  requireAuthority(context: GovernanceReadContext): Id | null {
    const authority = context.authority;
    if (authority.kind === "operator") {
      authority.installation.assertOwned();
      return null;
    }
    const { session } = authority;
    const live = this.requireSession(
      session.sessionId,
      RevisionIdSchema.parse(session.identity.userId),
      context.now,
    );
    if (live.role !== "teacher") governanceForbidden();
    return RevisionIdSchema.parse(live.userId);
  }

  requireScope(context: GovernanceReadContext, centerId: Id): void {
    const userId = this.requireAuthority(context);
    const row = this.database.readOne(
      `SELECT centers.id FROM marea_centers centers WHERE centers.id = ?1
        AND (?2 IS NULL OR EXISTS (SELECT 1 FROM marea_center_memberships membership
          WHERE membership.center_id = centers.id AND membership.user_id = ?2
            AND membership.state = 'active' AND membership.capability = 'administrator'))`,
      [centerId, userId],
    );
    if (row === undefined) governanceForbidden();
  }

  requireClass(context: GovernanceReadContext, centerId: Id, classId: Id) {
    this.requireScope(context, centerId);
    const row = this.database.readOne(
      `SELECT governed.class_id, governed.center_id, governed.version, classes.display_name
        FROM marea_governance_classes governed JOIN marea_classes classes ON classes.id = governed.class_id
        WHERE governed.class_id = ?1 AND governed.center_id = ?2`,
      [classId, centerId],
    );
    if (row === undefined) governanceForbidden();
    return this.classroom(row);
  }

  classroom(row: SqliteRow) {
    const classId = RevisionIdSchema.parse(rowText(row, "class_id"));
    return GovernanceClassSchema.parse({
      classId,
      centerId: rowText(row, "center_id"),
      version: rowText(row, "version"),
      displayName: rowText(row, "display_name"),
      operatorReady: this.operatorReady(classId),
    });
  }

  account(context: GovernanceReadContext, centerId: Id, userId: Id) {
    this.requireScope(context, centerId);
    const row = this.database.readOne(
      `SELECT users.id, users.role, users.display_name, accounts.state, accounts.version
        FROM marea_users users JOIN marea_governance_accounts accounts ON accounts.user_id = users.id
        JOIN marea_center_memberships membership ON membership.user_id = users.id
        WHERE users.id = ?1 AND membership.center_id = ?2 AND membership.state = 'active'`,
      [userId, centerId],
    );
    if (row === undefined) governanceForbidden();
    return this.accountProjection(context, centerId, row);
  }

  accountProjection(context: GovernanceReadContext, centerId: Id, row: SqliteRow) {
    const userId = RevisionIdSchema.parse(rowText(row, "id"));
    return GovernanceAccountSchema.parse({
      userId,
      centerId,
      displayName: rowText(row, "display_name"),
      role: rowText(row, "role"),
      state: rowText(row, "state"),
      version: rowText(row, "version"),
      canManageAccount:
        context.authority.kind === "operator" || this.canManageAccount(centerId, userId),
    });
  }

  canManageAccount(centerId: Id, userId: Id): boolean {
    return (
      this.database.readOne(
        `SELECT accounts.user_id FROM marea_governance_accounts accounts
        JOIN marea_users users ON users.id = accounts.user_id
        WHERE accounts.user_id = ?1 AND accounts.owner_center_id = ?2
          AND NOT EXISTS (SELECT 1 FROM marea_center_memberships centers WHERE centers.user_id = ?1
            AND (centers.center_id <> ?2 OR centers.capability = 'administrator'))
          AND NOT EXISTS (SELECT 1 FROM marea_governance_memberships memberships
            WHERE memberships.user_id = ?1 AND memberships.center_id <> ?2)
          AND (users.class_id IS NULL OR EXISTS (SELECT 1 FROM marea_governance_classes classes
            WHERE classes.class_id = users.class_id AND classes.center_id = ?2))
          AND NOT EXISTS (SELECT 1 FROM marea_teacher_classes legacy
            LEFT JOIN marea_governance_classes classes ON classes.class_id = legacy.class_id
            WHERE legacy.teacher_id = ?1 AND (classes.center_id IS NULL OR classes.center_id <> ?2))
          AND NOT EXISTS (SELECT 1 FROM marea_runs runs
            LEFT JOIN marea_governance_classes classes ON classes.class_id = runs.class_id
            WHERE runs.student_id = ?1 AND (classes.center_id IS NULL OR classes.center_id <> ?2))`,
        [userId, centerId],
      ) !== undefined
    );
  }

  editableAccount(context: GovernanceReadContext, centerId: Id, userId: Id, expectedVersion: Id) {
    const account = this.account(context, centerId, userId);
    if (!account.canManageAccount) governanceForbidden();
    this.requireVersion(account.version, expectedVersion);
    return account;
  }

  requireVersion(current: Id | null, expected: Id | null): void {
    if (current !== expected) governanceConflict();
  }

  membership(row: SqliteRow) {
    return MembershipSchema.parse({
      classId: rowText(row, "class_id"),
      centerId: rowText(row, "center_id"),
      userId: rowText(row, "user_id"),
      role: rowText(row, "role"),
      state: rowText(row, "state"),
      version: rowText(row, "version"),
    });
  }

  revoke(userId: Id, now: Time): void {
    this.database.execute(
      "UPDATE marea_auth_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL",
      [userId, now],
    );
    this.database.execute(
      "UPDATE marea_run_leases SET revoked_at = ?2 WHERE student_id = ?1 AND revoked_at IS NULL",
      [userId, now],
    );
  }

  audit(
    context: GovernanceCommitContext,
    centerId: Id,
    operation: string,
    targetId: Id,
    resultVersion = context.generatedVersion,
  ): void {
    const actor =
      context.authority.kind === "administrator" ? context.authority.session.identity.userId : null;
    this.database.execute(
      `INSERT INTO marea_governance_audit (request_id, actor_user_id, authority, center_id, operation,
        target_id, result_version, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      [
        context.requestId,
        actor,
        context.authority.kind,
        centerId,
        operation,
        targetId,
        resultVersion,
        context.now,
      ],
    );
  }
}
