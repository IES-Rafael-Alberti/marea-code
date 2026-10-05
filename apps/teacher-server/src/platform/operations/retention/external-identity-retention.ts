import type { ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import type { DerivedQuery } from "./retention-rows.js";

/** Schema 12 links accounts to the external identities that created them. */
export function hasExternalIdentityStorage(database: ReadOnlySqliteApplicationDatabase): boolean {
  return (
    database.readOne(
      "SELECT 1 FROM sqlite_schema WHERE name = 'marea_external_identities' AND type = 'table'",
    ) !== undefined
  );
}

export function externalIdentityAccountRows(
  database: ReadOnlySqliteApplicationDatabase,
): readonly DerivedQuery[] {
  return hasExternalIdentityStorage(database)
    ? [
        [
          "externalIdentities",
          "SELECT provider_id, subject, email, created_at, last_login_at, 1 AS rows, length(subject) + length(email) AS bytes FROM marea_external_identities WHERE user_id = ?1 ORDER BY provider_id, subject",
        ],
      ]
    : [];
}
