import type { PrincipalRole } from "@marea/protocol";
import type { GovernanceCommitContext, Id } from "../../governance/authority.js";
import type { GovernanceRepository, PreparedChangeMembership } from "../../governance/contracts.js";
import { GovernanceStore, governanceConflict } from "./governance-store.js";
import { rowText } from "./row-parser.boundary.js";
import { SINGLE_STUDENT_CLASS } from "./governance-access-sql.js";

export class GovernanceMembershipMutations implements Pick<
  GovernanceRepository,
  "commitChangeMembership"
> {
  constructor(private readonly store: GovernanceStore) {}

  commitChangeMembership(input: PreparedChangeMembership) {
    return this.store.database.transaction(() => {
      const { context, centerId, classId, userId, state, expectedVersion } = input;
      this.store.requireClass(context, centerId, classId);
      const account = this.store.account(context, centerId, userId);
      const previous = this.store.database.readOne(
        "SELECT version, state FROM marea_governance_memberships WHERE class_id = ?1 AND user_id = ?2",
        [classId, userId],
      );
      const version = previous === undefined ? null : rowText(previous, "version");
      if (version !== expectedVersion) governanceConflict();
      if (previous === undefined && state === "revoked") governanceConflict();
      if (state === "active" && account.role === "student") {
        const reassigning = previous === undefined || rowText(previous, "state") !== "active";
        this.requireStudentAssignment(userId, classId, centerId, reassigning);
      }
      if (previous === undefined) {
        this.insert(context, centerId, classId, userId, account.role);
      } else {
        this.store.database.execute(
          "UPDATE marea_governance_memberships SET state = ?3, version = ?4, updated_at = ?5 WHERE class_id = ?1 AND user_id = ?2",
          [classId, userId, state, context.generatedVersion, context.now],
        );
        if (state === "active" || rowText(previous, "state") === "active")
          this.project(context, classId, userId, account.role, state);
      }
      this.store.audit(context, centerId, "membership-change", userId);
      return Object.freeze({
        classId,
        centerId,
        userId,
        role: account.role,
        state,
        version: context.generatedVersion,
      });
    });
  }

  /** Used only inside the caller's account/bootstrap/adoption transaction. */
  insert(
    context: GovernanceCommitContext,
    centerId: Id,
    classId: Id,
    userId: Id,
    role: PrincipalRole,
  ): void {
    this.store.database.execute(
      `INSERT INTO marea_governance_memberships (class_id, center_id, user_id, role, state, version, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?6)`,
      [classId, centerId, userId, role, context.generatedVersion, context.now],
    );
    this.project(context, classId, userId, role, "active");
  }

  private requireStudentAssignment(
    userId: Id,
    classId: Id,
    centerId: Id,
    reassigning: boolean,
  ): void {
    if (
      this.store.database.readOne(
        `SELECT user_id FROM marea_governance_memberships WHERE user_id = ?1 AND role = 'student'
        AND state = 'active' AND class_id <> ?2 AND ${SINGLE_STUDENT_CLASS}
        UNION ALL SELECT student_id FROM marea_runs WHERE student_id = ?1 AND state = 'active' AND ?4 = 1
          AND (class_id = ?2 OR ${SINGLE_STUDENT_CLASS})
        UNION ALL SELECT user_id FROM marea_governance_accounts WHERE user_id = ?1 AND owner_center_id <> ?3
        UNION ALL SELECT id FROM marea_users WHERE id = ?1 AND class_id IS NOT NULL AND class_id <> ?2
          AND ${SINGLE_STUDENT_CLASS} LIMIT 1`,
        [userId, classId, centerId, reassigning],
      ) !== undefined
    )
      governanceConflict();
  }

  private project(
    context: GovernanceCommitContext,
    classId: Id,
    userId: Id,
    role: PrincipalRole,
    state: "active" | "revoked",
  ): void {
    if (role === "student") {
      // The legacy hint names the latest activated class, or another active one after revocation.
      this.store.database.execute(
        `UPDATE marea_users SET class_id = COALESCE(?2, (SELECT class_id FROM marea_governance_memberships
            WHERE user_id = ?1 AND role = 'student' AND state = 'active' ORDER BY class_id LIMIT 1))
          WHERE id = ?1 AND (?2 IS NOT NULL OR class_id = ?3)`,
        [userId, state === "active" ? classId : null, classId],
      );
      if (state === "revoked") this.store.revokeStudentClass(userId, classId, context.now);
      return;
    }
    if (state === "active") {
      this.store.database.execute(
        "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
        [userId, classId],
      );
    } else {
      this.store.database.execute(
        "DELETE FROM marea_teacher_classes WHERE teacher_id = ?1 AND class_id = ?2",
        [userId, classId],
      );
      this.store.database.execute(
        "UPDATE marea_users SET class_id = NULL WHERE id = ?1 AND class_id = ?2",
        [userId, classId],
      );
    }
  }
}
