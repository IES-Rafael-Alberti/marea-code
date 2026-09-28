import { RevisionIdSchema, UtcTimestampSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { GovernanceSessionResolver, Time } from "../../governance/authority.js";
import type { GovernanceRepository } from "../../governance/contracts.js";
import { rowText } from "./row-parser.boundary.js";

/** Resolves actual stored session metadata; no session ID or expiry comes from a DTO. */
export class SqliteGovernanceSessionResolver implements GovernanceSessionResolver {
  constructor(
    private readonly database: SqliteApplicationDatabase,
    private readonly repository: Pick<GovernanceRepository, "requireSession">,
  ) {}

  resolve(tokenHash: string, now: Time) {
    const row = this.database.readOne(
      `SELECT sessions.id, sessions.user_id, sessions.expires_at FROM marea_auth_sessions sessions
        JOIN marea_governance_accounts accounts ON accounts.user_id = sessions.user_id
        WHERE sessions.token_hash = ?1 AND sessions.revoked_at IS NULL AND sessions.expires_at > ?2
          AND accounts.state = 'active'`,
      [tokenHash, now],
    );
    if (row === undefined) return undefined;
    const sessionId = RevisionIdSchema.parse(rowText(row, "id"));
    return Object.freeze({
      sessionId,
      expiresAt: UtcTimestampSchema.parse(rowText(row, "expires_at")),
      identity: this.repository.requireSession(
        sessionId,
        RevisionIdSchema.parse(rowText(row, "user_id")),
        now,
      ),
    });
  }
}
