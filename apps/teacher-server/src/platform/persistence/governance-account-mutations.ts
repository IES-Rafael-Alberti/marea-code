import type {
  GovernanceRepository,
  PreparedCreateAccount,
  PreparedRenameAccount,
  PreparedChangeAccountState,
  PreparedRevokeSessions,
} from "../../governance/contracts.js";
import type { GovernanceCommitContext, Id } from "../../governance/authority.js";
import { GovernanceStore, governanceConflict } from "./governance-store.js";
import { GovernanceMembershipMutations } from "./governance-membership-mutations.js";

export class GovernanceAccountMutations implements Pick<
  GovernanceRepository,
  | "commitCreateAccount"
  | "commitRenameAccount"
  | "commitChangeAccountState"
  | "commitRevokeSessions"
> {
  constructor(private readonly store: GovernanceStore) {}

  commitCreateAccount(input: PreparedCreateAccount) {
    return this.store.database.transaction(() => {
      const { context, centerId, classId, userId, role, displayName, passwordHash } = input;
      this.store.requireScope(context, centerId);
      if (role === "student" && classId === null) governanceConflict();
      if (classId !== null) this.store.requireClass(context, centerId, classId);
      const login = input.login;
      if (
        this.store.database.readOne("SELECT id FROM marea_users WHERE id = ?1 OR login = ?2", [
          userId,
          login,
        ]) !== undefined ||
        !this.store.identities.accountCreatable(userId)
      )
        governanceConflict();
      this.store.database.execute(
        "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [userId, login, passwordHash, role, displayName, classId],
      );
      this.store.database.execute(
        "INSERT INTO marea_governance_accounts (user_id, owner_center_id, state, version, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, ?4, ?4)",
        [userId, centerId, context.generatedVersion, context.now],
      );
      this.store.database.execute(
        `INSERT INTO marea_center_memberships (center_id, user_id, capability, state, version, created_at, updated_at)
          VALUES (?1, ?2, 'member', 'active', ?3, ?4, ?4)`,
        [centerId, userId, context.generatedVersion, context.now],
      );
      if (classId !== null)
        new GovernanceMembershipMutations(this.store).insert(
          context,
          centerId,
          classId,
          userId,
          role,
        );
      this.store.audit(context, centerId, "account-create", userId);
      return this.store.account(context, centerId, userId);
    });
  }

  commitRenameAccount(input: PreparedRenameAccount) {
    return this.store.database.transaction(() => {
      const { context, centerId, userId, expectedVersion, displayName } = input;
      this.store.editableAccount(context, centerId, userId, expectedVersion);
      this.store.database.execute("UPDATE marea_users SET display_name = ?2 WHERE id = ?1", [
        userId,
        displayName,
      ]);
      this.updateVersion(context, userId);
      this.store.audit(context, centerId, "account-rename", userId);
      return this.store.account(context, centerId, userId);
    });
  }

  commitChangeAccountState(input: PreparedChangeAccountState) {
    return this.store.database.transaction(() => {
      const { context, centerId, userId, expectedVersion, state } = input;
      const account = this.store.editableAccount(context, centerId, userId, expectedVersion);
      // A pending credential cannot be activated through the ordinary state operation.
      // Keeping pending state also prevents disable -> activate from bypassing provisioning.
      if (account.state === "pending") governanceConflict();
      this.store.database.execute(
        "UPDATE marea_governance_accounts SET state = ?2 WHERE user_id = ?1",
        [userId, state],
      );
      this.updateVersion(context, userId);
      if (state === "disabled") this.store.revoke(userId, context.now);
      this.store.audit(context, centerId, "account-state", userId);
      return this.store.account(context, centerId, userId);
    });
  }

  commitRevokeSessions(input: PreparedRevokeSessions) {
    return this.store.database.transaction(() => {
      const { context, centerId, userId, expectedVersion } = input;
      this.store.editableAccount(context, centerId, userId, expectedVersion);
      this.store.revoke(userId, context.now);
      this.updateVersion(context, userId);
      this.store.audit(context, centerId, "sessions-revoke", userId);
      return Object.freeze({ userId, version: context.generatedVersion, revokedAt: context.now });
    });
  }

  private updateVersion(context: GovernanceCommitContext, userId: Id): void {
    this.store.database.execute(
      "UPDATE marea_governance_accounts SET version = ?2, updated_at = ?3 WHERE user_id = ?1",
      [userId, context.generatedVersion, context.now],
    );
  }
}
