import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { governanceCryptoIds } from "../../governance/crypto-ids.boundary.js";

/** Called inside bootstrap/enrollment's existing identity transaction. A class
 * must already have explicit ownership; unadopted classes produce no new rows.
 */
export function projectNewGovernedIdentity(
  database: SqliteApplicationDatabase,
  userId: string,
  createdAt: string,
): void {
  const version = governanceCryptoIds.createId("revision");
  database.execute(
    `INSERT INTO marea_governance_accounts (user_id, owner_center_id, state, version, created_at, updated_at)
      SELECT users.id, classes.center_id, 'active', ?2, ?3, ?3 FROM marea_users users
      JOIN marea_governance_classes classes ON classes.class_id = users.class_id WHERE users.id = ?1`,
    [userId, version, createdAt],
  );
  database.execute(
    `INSERT INTO marea_center_memberships (center_id, user_id, capability, state, version, created_at, updated_at)
      SELECT owner_center_id, user_id, 'member', 'active', ?2, ?3, ?3 FROM marea_governance_accounts WHERE user_id = ?1`,
    [userId, version, createdAt],
  );
  database.execute(
    `INSERT INTO marea_governance_memberships (class_id, center_id, user_id, role, state, version, created_at, updated_at)
      SELECT users.class_id, accounts.owner_center_id, users.id, users.role, 'active', ?2, ?3, ?3 FROM marea_users users
      JOIN marea_governance_accounts accounts ON accounts.user_id = users.id WHERE users.id = ?1`,
    [userId, version, createdAt],
  );
}
