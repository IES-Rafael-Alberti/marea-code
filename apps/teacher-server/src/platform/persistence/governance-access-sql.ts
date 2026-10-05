/** Internal SQL expressions only: callers supply fixed column/parameter expressions,
 * never request text. Unadopted identities retain their legacy access rules.
 */
export function activeGovernanceAccount(user: string): string {
  return `NOT EXISTS (SELECT 1 FROM marea_governance_accounts governance_account
    WHERE governance_account.user_id = ${user} AND governance_account.state <> 'active')`;
}

/** An adopted class cannot fall back to a stale legacy join or class_id hint. */
export function activeGovernanceMembership(user: string, classroom: string, role: string): string {
  return `(${activeGovernanceAccount(user)} AND (
    NOT EXISTS (SELECT 1 FROM marea_governance_classes governed_class
      WHERE governed_class.class_id = ${classroom})
    OR EXISTS (SELECT 1 FROM marea_governance_memberships governed_membership
      JOIN marea_governance_accounts governed_account ON governed_account.user_id = governed_membership.user_id
      JOIN marea_center_memberships governed_center ON governed_center.user_id = governed_membership.user_id
        AND governed_center.center_id = governed_membership.center_id
      WHERE governed_membership.user_id = ${user} AND governed_membership.class_id = ${classroom}
        AND governed_membership.role = ${role} AND governed_membership.state = 'active'
        AND governed_account.state = 'active' AND governed_center.state = 'active'))) `;
}

/** An adopted class admits a student through an active membership; an unadopted one through
 * the legacy `class_id`. Account and center state are checked separately. */
export function studentClassMember(user: string, classroom: string): string {
  return `(CASE WHEN EXISTS (SELECT 1 FROM marea_governance_classes member_class
      WHERE member_class.class_id = ${classroom})
    THEN EXISTS (SELECT 1 FROM marea_governance_memberships member
      WHERE member.user_id = ${user} AND member.class_id = ${classroom}
        AND member.role = 'student' AND member.state = 'active')
    ELSE EXISTS (SELECT 1 FROM marea_users legacy_member
      WHERE legacy_member.id = ${user} AND legacy_member.class_id = ${classroom}) END)`;
}

/** A student who may act for this class now: a member with an active account and center. */
export function activeStudentClass(user: string, classroom: string): string {
  return `(${studentClassMember(user, classroom)} AND ${activeGovernanceMembership(user, classroom, "'student'")})`;
}

/** Schemas before 12 enforce one active class per student with this unique index. */
export const SINGLE_STUDENT_CLASS = `EXISTS (SELECT 1 FROM sqlite_schema
  WHERE type = 'index' AND name = 'marea_governance_one_student_class')`;
