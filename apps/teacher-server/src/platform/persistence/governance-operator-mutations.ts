import { CenterSchema, RevisionIdSchema } from "@marea/protocol";
import type { GovernanceCommitContext, Id } from "../../governance/authority.js";
import type {
  GovernanceRepository,
  OperatorCommitContext,
  OperatorCenterAssociation,
} from "../../governance/contracts.js";
import { GovernanceStore, governanceConflict, governanceForbidden } from "./governance-store.js";
import { rowText } from "./row-parser.boundary.js";

export function operatorCommit(context: OperatorCommitContext): GovernanceCommitContext {
  return { ...context, authority: { kind: "operator", installation: context.authority } };
}

type Input<K extends keyof GovernanceRepository> = Parameters<GovernanceRepository[K]>[0];

export class GovernanceOperatorMutations implements Pick<
  GovernanceRepository,
  | "commitCreateCenter"
  | "commitRenameCenter"
  | "commitAssociateAccount"
  | "commitSetAdministrator"
  | "commitProvisionCredential"
> {
  constructor(private readonly store: GovernanceStore) {}

  commitCreateCenter(input: Input<"commitCreateCenter">) {
    return this.store.database.transaction(() => {
      const { centerId, displayName } = input;
      const context = operatorCommit(input.context);
      this.store.requireAuthority(context);
      if (
        this.store.database.readOne("SELECT id FROM marea_centers WHERE id = ?1", [centerId]) !==
        undefined
      )
        governanceConflict();
      this.store.database.execute(
        "INSERT INTO marea_centers (id, display_name, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        [centerId, displayName, context.generatedVersion, context.now],
      );
      this.store.audit(context, centerId, "center-create", centerId);
      return CenterSchema.parse({ centerId, displayName, version: context.generatedVersion });
    });
  }

  commitRenameCenter(input: Input<"commitRenameCenter">) {
    return this.store.database.transaction(() => {
      const { centerId, displayName, expectedVersion } = input;
      const context = operatorCommit(input.context);
      this.store.requireAuthority(context);
      const row = this.store.database.readOne("SELECT version FROM marea_centers WHERE id = ?1", [
        centerId,
      ]);
      if (row === undefined) governanceForbidden();
      this.store.requireVersion(RevisionIdSchema.parse(rowText(row, "version")), expectedVersion);
      this.store.database.execute(
        "UPDATE marea_centers SET display_name = ?2, version = ?3, updated_at = ?4 WHERE id = ?1",
        [centerId, displayName, context.generatedVersion, context.now],
      );
      this.store.audit(context, centerId, "center-rename", centerId);
      return CenterSchema.parse({ centerId, displayName, version: context.generatedVersion });
    });
  }

  commitAssociateAccount(input: Input<"commitAssociateAccount">): OperatorCenterAssociation {
    return this.store.database.transaction(() => {
      const { centerId, userId } = input;
      const context = operatorCommit(input.context);
      this.store.requireScope(context, centerId);
      this.ownerCenter(userId);
      if (
        this.store.database.readOne(
          "SELECT user_id FROM marea_center_memberships WHERE center_id = ?1 AND user_id = ?2",
          [centerId, userId],
        ) !== undefined
      )
        governanceConflict();
      this.store.database.execute(
        `INSERT INTO marea_center_memberships (center_id, user_id, capability, state, version, created_at, updated_at)
          VALUES (?1, ?2, 'member', 'active', ?3, ?4, ?4)`,
        [centerId, userId, context.generatedVersion, context.now],
      );
      this.store.audit(context, centerId, "account-associate", userId);
      return Object.freeze({
        centerId,
        userId,
        capability: "member",
        state: "active",
        version: context.generatedVersion,
      });
    });
  }

  commitSetAdministrator(input: Input<"commitSetAdministrator">): OperatorCenterAssociation {
    return this.store.database.transaction(() => {
      const { centerId, userId, expectedVersion, capability } = input;
      const context = operatorCommit(input.context);
      this.store.requireScope(context, centerId);
      const row = this.store.database.readOne(
        `SELECT membership.version, users.role, accounts.state FROM marea_center_memberships membership
          JOIN marea_users users ON users.id = membership.user_id
          JOIN marea_governance_accounts accounts ON accounts.user_id = users.id
          WHERE membership.center_id = ?1 AND membership.user_id = ?2 AND membership.state = 'active'`,
        [centerId, userId],
      );
      if (row === undefined) governanceForbidden();
      if (rowText(row, "role") !== "teacher" || rowText(row, "state") !== "active")
        governanceConflict();
      this.store.requireVersion(RevisionIdSchema.parse(rowText(row, "version")), expectedVersion);
      this.store.database.execute(
        "UPDATE marea_center_memberships SET capability = ?3, version = ?4, updated_at = ?5 WHERE center_id = ?1 AND user_id = ?2",
        [centerId, userId, capability, context.generatedVersion, context.now],
      );
      this.store.audit(context, centerId, "administrator-set", userId);
      return Object.freeze({
        centerId,
        userId,
        capability,
        state: "active",
        version: context.generatedVersion,
      });
    });
  }

  commitProvisionCredential(input: Input<"commitProvisionCredential">) {
    return this.store.database.transaction(() => {
      const { userId, expectedVersion, passwordHash } = input;
      const context = operatorCommit(input.context);
      this.store.requireAuthority(context);
      const centerId = this.ownerCenter(userId);
      this.store.editableAccount(context, centerId, userId, expectedVersion);
      this.store.database.execute("UPDATE marea_users SET password_hash = ?2 WHERE id = ?1", [
        userId,
        passwordHash,
      ]);
      this.store.database.execute(
        "UPDATE marea_governance_accounts SET state = 'active', version = ?2, updated_at = ?3 WHERE user_id = ?1",
        [userId, context.generatedVersion, context.now],
      );
      this.store.revoke(userId, context.now);
      this.store.audit(context, centerId, "credential-provision", userId);
      return Object.freeze({ userId, version: context.generatedVersion });
    });
  }

  private ownerCenter(userId: Id): Id {
    const row = this.store.database.readOne(
      "SELECT owner_center_id FROM marea_governance_accounts WHERE user_id = ?1",
      [userId],
    );
    if (row === undefined) governanceForbidden();
    return RevisionIdSchema.parse(rowText(row, "owner_center_id"));
  }
}
