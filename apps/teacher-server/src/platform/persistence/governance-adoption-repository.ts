import { RevisionIdSchema } from "@marea/protocol";
import type { GovernanceRepository, OperatorCommitContext } from "../../governance/contracts.js";
import type { Id } from "../../governance/authority.js";
import type { AdoptionMap } from "../../governance/adoption-contracts.js";
import { parseAdoptionMap } from "../../governance/adoption-validation.boundary.js";
import { GovernanceStore, governanceConflict } from "./governance-store.js";
import { operatorCommit } from "./governance-operator-mutations.js";
import { adoptionInventory } from "./governance-adoption-inventory.js";
import { rowText } from "./row-parser.boundary.js";

export class GovernanceAdoptionRepository implements Pick<
  GovernanceRepository,
  "previewAdoption" | "commitAdoption"
> {
  constructor(private readonly store: GovernanceStore) {}

  previewAdoption(input: Parameters<GovernanceRepository["previewAdoption"]>[0]) {
    const map = parseAdoptionMap(input.map);
    return this.store.database.transaction(() => {
      input.authority.assertOwned();
      return adoptionInventory(this.store.database, map).receipt;
    });
  }

  commitAdoption(input: Parameters<GovernanceRepository["commitAdoption"]>[0]) {
    const map = parseAdoptionMap(input.map);
    return this.store.database.transaction(() => {
      input.context.authority.assertOwned();
      const inventory = adoptionInventory(this.store.database, map);
      const receipt = inventory.receipt;
      if (
        receipt.digest !== input.expectedInventoryDigest ||
        receipt.missingClassIds.length !== 0 ||
        receipt.missingUserIds.length !== 0
      )
        governanceConflict();
      const touched = new Set<Id>();
      for (const entry of map.classes) {
        if (
          this.store.database.readOne(
            "SELECT class_id FROM marea_governance_classes WHERE class_id = ?1",
            [entry.classId],
          ) !== undefined
        )
          continue;
        this.store.database.execute(
          "INSERT INTO marea_governance_classes VALUES (?1, ?2, ?3, ?4, ?4)",
          [entry.classId, entry.centerId, input.context.generatedVersion, input.context.now],
        );
        touched.add(entry.centerId);
      }
      for (const entry of map.accounts) {
        if (
          this.store.database.readOne(
            "SELECT user_id FROM marea_governance_accounts WHERE user_id = ?1",
            [entry.userId],
          ) === undefined
        ) {
          this.store.database.execute(
            "INSERT INTO marea_governance_accounts VALUES (?1, ?2, 'active', ?3, ?4, ?4)",
            [entry.userId, entry.ownerCenterId, input.context.generatedVersion, input.context.now],
          );
        }
        this.associate(input.context, entry.ownerCenterId, entry.userId, map, touched);
      }
      const centers = new Map(map.classes.map((entry) => [entry.classId, entry.centerId]));
      for (const relationship of inventory.relationships) {
        const centerId = centers.get(relationship.classId);
        if (centerId === undefined) governanceConflict();
        this.associate(input.context, centerId, relationship.userId, map, touched);
        const previous = this.store.database.readOne(
          "SELECT role, state FROM marea_governance_memberships WHERE class_id = ?1 AND user_id = ?2",
          [relationship.classId, relationship.userId],
        );
        if (previous !== undefined) {
          if (
            rowText(previous, "role") !== relationship.role ||
            rowText(previous, "state") !== "active"
          )
            governanceConflict();
          continue;
        }
        this.store.database.execute(
          "INSERT INTO marea_governance_memberships VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?6)",
          [
            relationship.classId,
            centerId,
            relationship.userId,
            relationship.role,
            input.context.generatedVersion,
            input.context.now,
          ],
        );
        touched.add(centerId);
      }
      for (const grant of map.administrators)
        this.associate(input.context, grant.centerId, grant.userId, map, touched);
      for (const center of touched)
        this.store.audit(operatorCommit(input.context), center, "adoption-confirm", center);
      return receipt;
    });
  }

  private associate(
    context: OperatorCommitContext,
    centerId: Id,
    userId: Id,
    map: AdoptionMap,
    touched: Set<Id>,
  ): void {
    const administrator = map.administrators.some(
      (grant) => grant.userId === userId && grant.centerId === centerId,
    );
    if (
      administrator &&
      this.store.database.readOne(
        "SELECT users.id FROM marea_users users JOIN marea_governance_accounts accounts ON accounts.user_id = users.id WHERE users.id = ?1 AND users.role = 'teacher' AND accounts.state = 'active'",
        [userId],
      ) === undefined
    )
      governanceConflict();
    const previous = this.store.database.readOne(
      "SELECT capability, state FROM marea_center_memberships WHERE center_id = ?1 AND user_id = ?2",
      [centerId, userId],
    );
    if (previous !== undefined) {
      if (
        rowText(previous, "state") !== "active" ||
        (administrator && rowText(previous, "capability") !== "administrator")
      )
        governanceConflict();
      return;
    }
    this.store.database.execute(
      "INSERT INTO marea_center_memberships VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?5)",
      [
        centerId,
        userId,
        administrator ? "administrator" : "member",
        context.generatedVersion,
        context.now,
      ],
    );
    touched.add(RevisionIdSchema.parse(centerId));
  }
}
