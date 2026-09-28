import { educationalAccountRows } from "./educational-retention.js";
import { profileRetentionRows } from "./profile-retention.js";
import { canonicalJsonBytes, protocolDigest } from "../canonical-encoder.js";
import type { ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import { TargetRefSchema, type TargetRef } from "../schemas.js";
import { blockersOf, measure, type BlockerQuery, type DerivedQuery } from "./retention-rows.js";
import type { ContentInspection } from "./retention-runs.js";

type AccountTarget = Extract<TargetRef, { kind: "account" }>;

export interface AccountInspection extends ContentInspection<AccountTarget> {
  readonly runIds: readonly string[];
  readonly memberships: readonly TargetRef[];
}

/** Every row deleted with a student account besides its runs. */
function accountRows(): readonly DerivedQuery[] {
  return [
    [
      "user",
      "SELECT login, role, display_name, class_id, 1 AS rows, 0 AS bytes FROM marea_users WHERE id = ?1",
    ],
    [
      "governance",
      "SELECT state, version, 1 AS rows, 0 AS bytes FROM marea_governance_accounts WHERE user_id = ?1",
    ],
    [
      "classMemberships",
      "SELECT class_id, version, 1 AS rows, 0 AS bytes FROM marea_governance_memberships WHERE user_id = ?1 ORDER BY class_id",
    ],
    [
      "centerMemberships",
      "SELECT center_id, version, 1 AS rows, 0 AS bytes FROM marea_center_memberships WHERE user_id = ?1 ORDER BY center_id",
    ],
    [
      "sessions",
      "SELECT id, revoked_at, expires_at, 1 AS rows, 0 AS bytes FROM marea_auth_sessions WHERE user_id = ?1 ORDER BY id",
    ],
    [
      "invitations",
      "SELECT code_hash, 1 AS rows, 0 AS bytes FROM marea_invitations WHERE consumed_by = ?1 ORDER BY code_hash",
    ],
  ];
}

/** Privileged or referenced accounts would rewrite audit, authorship or live sessions. */
function accountBlockers(): readonly BlockerQuery[] {
  return [
    [
      "protected",
      "teacher-account",
      "SELECT 1 FROM marea_users WHERE id = ?1 AND role <> 'student'",
    ],
    [
      "protected",
      "administrator",
      "SELECT 1 FROM marea_center_memberships WHERE user_id = ?1 AND capability = 'administrator'",
    ],
    ["protected", "audit-actor", "SELECT 1 FROM marea_governance_audit WHERE actor_user_id = ?1"],
    [
      "protected",
      "teaching-author",
      "SELECT 1 FROM marea_class_teaching_revisions WHERE created_by = ?1",
    ],
    [
      "protected",
      "exchange-preview",
      "SELECT 1 FROM marea_class_exchange_previews WHERE user_id = ?1",
    ],
    [
      "active",
      "session-live",
      "SELECT 1 FROM marea_auth_sessions WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
    ],
  ];
}

export function membershipNodes(
  database: ReadOnlySqliteApplicationDatabase,
  userId: string,
): readonly TargetRef[] {
  const nodes = (sql: string, kind: string, scope: string) =>
    database.readAll(sql, [userId]).map((row) =>
      TargetRefSchema.parse({
        kind,
        key: { [scope]: row.scope, userId },
        observed: { kind: "version", version: row.version },
      }),
    );
  return [
    ...nodes(
      "SELECT class_id AS scope, version FROM marea_governance_memberships WHERE user_id = ?1 ORDER BY class_id",
      "class-membership",
      "classId",
    ),
    ...nodes(
      "SELECT center_id AS scope, version FROM marea_center_memberships WHERE user_id = ?1 ORDER BY center_id",
      "center-membership",
      "centerId",
    ),
  ];
}

/** The stable identity and current version of an account, or undefined when it does not exist. */
export function accountNode(
  database: ReadOnlySqliteApplicationDatabase,
  userId: string,
): AccountTarget | undefined {
  const user = database.readOne(
    "SELECT login, role, display_name, class_id FROM marea_users WHERE id = ?1",
    [userId],
  );
  if (user === undefined) return undefined;
  const governance = database.readOne(
    "SELECT version FROM marea_governance_accounts WHERE user_id = ?1",
    [userId],
  );
  return TargetRefSchema.parse({
    kind: "account",
    key: { userId },
    observed: {
      kind: "version",
      version: governance?.version ?? protocolDigest(canonicalJsonBytes({ ...user })),
    },
  }) as AccountTarget;
}

export function inspectAccount(
  database: ReadOnlySqliteApplicationDatabase,
  userId: string,
  now: string,
): AccountInspection | undefined {
  const node = accountNode(database, userId);
  if (node === undefined) return undefined;
  return {
    node,
    runIds: database
      .readAll("SELECT id FROM marea_runs WHERE student_id = ?1 ORDER BY id", [userId])
      .map((row) => String(row.id)),
    memberships: membershipNodes(database, userId),
    blockers: blockersOf(database, accountBlockers(), node, userId, now),
    ...measure(
      database,
      [...accountRows(), ...profileRetentionRows(database), ...educationalAccountRows(database)],
      userId,
    ),
  };
}
