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
