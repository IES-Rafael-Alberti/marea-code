import { MAX_EXTERNAL_RULES_PER_CLASS, type ExternalAccessRule } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import type {
  ClassAdmissionRules,
  ExternalIdentityRepository,
  ExternalProvisioning,
  ExternalRuleChange,
} from "../../external-identity/contracts.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { activeGovernanceMembership } from "./governance-access-sql.js";
import type { IdentityCreationGuard } from "./identity-creation-guard.js";
import { rowText } from "./row-parser.boundary.js";
import { revokeStudentClassAccess } from "./student-classes.js";

function conflict(): never {
  throw new TeacherDomainError("request.conflict");
}

export class SqliteExternalIdentityRepository implements ExternalIdentityRepository {
  readonly #database: SqliteApplicationDatabase;
  readonly #identities: IdentityCreationGuard;

  public constructor(database: SqliteApplicationDatabase, identities: IdentityCreationGuard) {
    this.#database = database;
    this.#identities = identities;
  }

  public available(): boolean {
    return (
      this.#database.readOne(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'marea_external_identities'",
      ) !== undefined
    );
  }

  public classRules(providerId: string): readonly ClassAdmissionRules[] {
    const grouped = new Map<string, { kind: string; value: string }[]>();
    for (const row of this.#database.readAll(
      `SELECT class_id, kind, value FROM marea_external_admission_rules
        WHERE provider_id = ?1 ORDER BY class_id, kind, value`,
      [providerId],
    )) {
      const classId = rowText(row, "class_id");
      const rules = grouped.get(classId) ?? [];
      rules.push({ kind: rowText(row, "kind"), value: rowText(row, "value") });
      grouped.set(classId, rules);
    }
    return [...grouped].map(([classId, rules]) => ({ classId, rules }));
  }

  public provision(input: ExternalProvisioning): AuthenticatedIdentity | undefined {
    return this.#database.transaction(() => {
      const known = this.#database.readOne(
        "SELECT user_id FROM marea_external_identities WHERE provider_id = ?1 AND subject = ?2",
        [input.providerId, input.subject],
      );
      const userId = known === undefined ? this.createAccount(input) : rowText(known, "user_id");
      if (userId === undefined) return undefined;
      const account = this.#database.readOne(
        `SELECT users.display_name, accounts.owner_center_id FROM marea_users users
          JOIN marea_governance_accounts accounts ON accounts.user_id = users.id
          WHERE users.id = ?1 AND users.role = 'student' AND accounts.state = 'active'`,
        [userId],
      );
      if (account === undefined) return undefined;
      this.#database.execute(
        `UPDATE marea_external_identities SET email = ?3, last_login_at = ?4
          WHERE provider_id = ?1 AND subject = ?2`,
        [input.providerId, input.subject, input.email, input.now],
      );
      this.synchronize(userId, rowText(account, "owner_center_id"), input);
      return {
        classId: null,
        displayName: rowText(account, "display_name"),
        role: "student",
        userId,
      };
    });
  }

  public teacherClassAccess(teacherId: string, classId: string): boolean {
    const row = this.#database.readOne(
      `SELECT EXISTS (SELECT 1 FROM marea_governance_classes governed
          WHERE governed.class_id = membership.class_id) AS governed
        FROM marea_users users
        JOIN marea_teacher_classes membership ON membership.teacher_id = users.id
        WHERE users.id = ?1 AND membership.class_id = ?2 AND users.role = 'teacher'
          AND ${activeGovernanceMembership("users.id", "membership.class_id", "'teacher'")}`,
      [teacherId, classId],
    );
    if (row === undefined) throw new TeacherDomainError("dashboard.forbidden");
    return Number(row.governed) === 1;
  }

  public classRulesFor(
    classId: string,
    providerIds: readonly string[],
  ): readonly ExternalAccessRule[] {
    return this.#database
      .readAll(
        `SELECT provider_id, kind, value FROM marea_external_admission_rules
          WHERE class_id = ?1 ORDER BY provider_id, kind, value`,
        [classId],
      )
      .map((row) => ({
        providerId: rowText(row, "provider_id"),
        kind: rowText(row, "kind"),
        value: rowText(row, "value"),
      }))
      .filter((rule) => providerIds.includes(rule.providerId));
  }

  public changeRules(change: ExternalRuleChange): void {
    this.#database.transaction(() => {
      if (!this.teacherClassAccess(change.teacherId, change.classId)) conflict();
      for (const value of change.values) {
        const rule = [change.classId, change.providerId, change.kind, value];
        if (change.operation === "add")
          this.#database.execute(
            `INSERT INTO marea_external_admission_rules
              (class_id, provider_id, kind, value, created_by, created_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`,
            [...rule, change.teacherId, change.now],
          );
        else
          this.#database.execute(
            `DELETE FROM marea_external_admission_rules
              WHERE class_id = ?1 AND provider_id = ?2 AND kind = ?3 AND value = ?4`,
            rule,
          );
      }
      if (
        this.#database.readOne(
          `SELECT 1 FROM marea_external_admission_rules WHERE class_id = ?1
            ORDER BY provider_id, kind, value LIMIT 1 OFFSET ?2`,
          [change.classId, MAX_EXTERNAL_RULES_PER_CLASS],
        ) !== undefined
      )
        conflict();
    });
  }

  /** A first sign-in creates an active student owned by the center of its first admitted class. */
  private createAccount(input: ExternalProvisioning): string | undefined {
    const first = this.#database.readOne(
      `SELECT class_id, center_id FROM marea_governance_classes
        WHERE class_id IN (SELECT value FROM json_each(?1)) ORDER BY class_id LIMIT 1`,
      [JSON.stringify(input.admittedClassIds)],
    );
    if (first === undefined) return undefined;
    if (
      this.#database.readOne("SELECT id FROM marea_users WHERE id = ?1 OR login = ?2", [
        input.newUserId,
        input.newLogin,
      ]) !== undefined ||
      !this.#identities.accountCreatable(input.newUserId)
    )
      conflict();
    const centerId = rowText(first, "center_id");
    const values = [input.newUserId, centerId, input.version, input.now];
    this.#database.execute(
      `INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id)
        VALUES (?1, ?2, '', 'student', ?3, ?4)`,
      [input.newUserId, input.newLogin, input.displayName, rowText(first, "class_id")],
    );
    this.#database.execute(
      `INSERT INTO marea_governance_accounts (user_id, owner_center_id, state, version, created_at, updated_at)
        VALUES (?1, ?2, 'active', ?3, ?4, ?4)`,
      values,
    );
    this.#database.execute(
      `INSERT INTO marea_center_memberships (center_id, user_id, capability, state, version, created_at, updated_at)
        VALUES (?2, ?1, 'member', 'active', ?3, ?4, ?4)`,
      values,
    );
    this.#database.execute(
      `INSERT INTO marea_external_identities
        (provider_id, subject, user_id, email, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      [input.providerId, input.subject, input.newUserId, input.email, input.now],
    );
    return input.newUserId;
  }

  /**
   * Activates every admitted class of the account's center and ends the memberships this
   * provider granted that no rule admits any longer. Memberships granted by people stay.
   */
  private synchronize(userId: string, centerId: string, input: ExternalProvisioning): void {
    const admitted = JSON.stringify(input.admittedClassIds);
    const parameters = [userId, centerId, admitted, input.providerId, input.version, input.now];
    const ended = this.#database.readAll(
      `UPDATE marea_governance_memberships SET state = 'revoked', version = ?4, updated_at = ?5
        WHERE user_id = ?1 AND role = 'student' AND state = 'active' AND external_provider = ?3
          AND class_id NOT IN (SELECT value FROM json_each(?2))
        RETURNING class_id`,
      [userId, admitted, input.providerId, input.version, input.now],
    );
    for (const row of ended)
      revokeStudentClassAccess(this.#database, userId, rowText(row, "class_id"), input.now);
    this.#database.execute(
      `UPDATE marea_governance_memberships
        SET state = 'active', external_provider = ?4, version = ?5, updated_at = ?6
        WHERE user_id = ?1 AND role = 'student' AND state = 'revoked' AND center_id = ?2
          AND class_id IN (SELECT value FROM json_each(?3))`,
      parameters,
    );
    this.#database.execute(
      `INSERT INTO marea_governance_memberships
        (class_id, center_id, user_id, role, state, version, created_at, updated_at, external_provider)
        SELECT classes.class_id, classes.center_id, ?1, 'student', 'active', ?5, ?6, ?6, ?4
        FROM marea_governance_classes classes
        WHERE classes.center_id = ?2 AND classes.class_id IN (SELECT value FROM json_each(?3))
        ON CONFLICT DO NOTHING`,
      parameters,
    );
    this.#database.execute(
      `UPDATE marea_users SET class_id = (SELECT class_id FROM marea_governance_memberships
          WHERE user_id = ?1 AND role = 'student' AND state = 'active' ORDER BY class_id LIMIT 1)
        WHERE id = ?1 AND (class_id IS NULL OR NOT EXISTS (SELECT 1 FROM marea_governance_memberships
          WHERE user_id = ?1 AND class_id = marea_users.class_id AND state = 'active'))`,
      [userId],
    );
  }
}
