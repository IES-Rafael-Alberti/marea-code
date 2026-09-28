import { CenterSchema, RevisionIdSchema, MAX_GOVERNANCE_PAGE_SIZE } from "@marea/protocol";
import type { GovernancePage } from "@marea/protocol";
import type { GovernanceReadContext, Id, Time } from "../../governance/authority.js";
import type { GovernanceClassScope, GovernanceRepository } from "../../governance/contracts.js";
import { GovernanceStore, governanceForbidden } from "./governance-store.js";
import { rowText } from "./row-parser.boundary.js";

function page<T>(rows: readonly T[], id: (row: T) => Id): GovernancePage<T> {
  const items = Object.freeze(rows.slice(0, MAX_GOVERNANCE_PAGE_SIZE));
  const last = rows.length > MAX_GOVERNANCE_PAGE_SIZE ? items.at(-1) : undefined;
  return Object.freeze({
    items,
    nextAfterId: last === undefined ? null : id(last),
  });
}

export class GovernanceReads implements Pick<
  GovernanceRepository,
  | "requireSession"
  | "requireAdministrator"
  | "requireAccess"
  | "listCenters"
  | "listClasses"
  | "listAccounts"
  | "listMemberships"
> {
  constructor(private readonly store: GovernanceStore) {}

  requireSession(sessionId: Id, userId: Id, now: Time) {
    return this.store.requireSession(sessionId, userId, now);
  }

  requireAdministrator(sessionId: Id, centerId: Id, now: Time): void {
    const row = this.store.database.readOne(
      `SELECT sessions.user_id FROM marea_auth_sessions sessions
        JOIN marea_users users ON users.id = sessions.user_id
        JOIN marea_governance_accounts accounts ON accounts.user_id = users.id
        JOIN marea_center_memberships membership ON membership.user_id = users.id
        JOIN marea_centers centers ON centers.id = membership.center_id
        WHERE sessions.id = ?1 AND membership.center_id = ?2 AND sessions.expires_at > ?3
          AND sessions.revoked_at IS NULL AND accounts.state = 'active' AND users.role = 'teacher'
          AND membership.capability = 'administrator' AND membership.state = 'active'`,
      [sessionId, centerId, now],
    );
    if (row === undefined) governanceForbidden();
  }

  requireAccess(context: GovernanceReadContext): { readonly administrator: true } {
    const userId = this.store.requireAuthority(context);
    if (
      userId !== null &&
      this.store.database.readOne(
        `SELECT membership.center_id FROM marea_center_memberships membership
        JOIN marea_centers centers ON centers.id = membership.center_id
        WHERE membership.user_id = ?1 AND membership.state = 'active'
          AND membership.capability = 'administrator' LIMIT 1`,
        [userId],
      ) === undefined
    )
      governanceForbidden();
    return Object.freeze({ administrator: true });
  }

  listCenters(context: GovernanceReadContext, afterId: Id | null) {
    this.requireAccess(context);
    const userId = this.store.requireAuthority(context);
    const rows = this.store.database
      .readAll(
        `SELECT centers.id, centers.display_name, centers.version FROM marea_centers centers
        WHERE (?1 IS NULL OR EXISTS (SELECT 1 FROM marea_center_memberships membership
          WHERE membership.center_id = centers.id AND membership.user_id = ?1
            AND membership.capability = 'administrator' AND membership.state = 'active'))
          AND (?2 IS NULL OR centers.id > ?2 COLLATE BINARY)
        ORDER BY centers.id COLLATE BINARY ASC LIMIT ?3`,
        [userId, afterId, MAX_GOVERNANCE_PAGE_SIZE + 1],
      )
      .map((row) =>
        CenterSchema.parse({
          centerId: rowText(row, "id"),
          displayName: rowText(row, "display_name"),
          version: rowText(row, "version"),
        }),
      );
    return page(rows, (row) => row.centerId);
  }

  listClasses(context: GovernanceReadContext, centerId: Id, afterId: Id | null) {
    this.store.requireScope(context, centerId);
    const rows = this.store.database
      .readAll(
        `SELECT governed.class_id, governed.center_id, governed.version, classes.display_name
        FROM marea_governance_classes governed JOIN marea_classes classes ON classes.id = governed.class_id
        WHERE governed.center_id = ?1 AND (?2 IS NULL OR governed.class_id > ?2 COLLATE BINARY)
        ORDER BY governed.class_id COLLATE BINARY ASC LIMIT ?3`,
        [centerId, afterId, MAX_GOVERNANCE_PAGE_SIZE + 1],
      )
      .map((row) => this.store.classroom(row));
    return page(rows, (row) => row.classId);
  }

  listAccounts(context: GovernanceReadContext, centerId: Id, afterId: Id | null) {
    this.store.requireScope(context, centerId);
    const rows = this.store.database
      .readAll(
        `SELECT users.id, users.display_name, users.role, accounts.state, accounts.version
        FROM marea_center_memberships membership JOIN marea_users users ON users.id = membership.user_id
        JOIN marea_governance_accounts accounts ON accounts.user_id = users.id
        WHERE membership.center_id = ?1 AND membership.state = 'active'
          AND (?2 IS NULL OR users.id > ?2 COLLATE BINARY)
        ORDER BY users.id COLLATE BINARY ASC LIMIT ?3`,
        [centerId, afterId, MAX_GOVERNANCE_PAGE_SIZE + 1],
      )
      .map((row) => this.store.accountProjection(context, centerId, row));
    return page(rows, (row) => row.userId);
  }

  listMemberships(scope: GovernanceClassScope, afterId: Id | null) {
    this.store.requireClass(scope.context, scope.centerId, scope.classId);
    const rows = this.store.database
      .readAll(
        `SELECT class_id, center_id, user_id, role, state, version FROM marea_governance_memberships
        WHERE class_id = ?1 AND center_id = ?2 AND (?3 IS NULL OR user_id > ?3 COLLATE BINARY)
        ORDER BY user_id COLLATE BINARY ASC LIMIT ?4`,
        [scope.classId, scope.centerId, afterId, MAX_GOVERNANCE_PAGE_SIZE + 1],
      )
      .map((row) => this.store.membership(row));
    return page(rows, (row) => RevisionIdSchema.parse(row.userId));
  }
}
