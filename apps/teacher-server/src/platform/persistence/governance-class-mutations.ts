import type {
  GovernanceRepository,
  PreparedCreateClass,
  PreparedRenameClass,
} from "../../governance/contracts.js";
import { GovernanceStore, governanceConflict } from "./governance-store.js";

export class GovernanceClassMutations implements Pick<
  GovernanceRepository,
  "commitCreateClass" | "commitRenameClass"
> {
  constructor(private readonly store: GovernanceStore) {}

  commitCreateClass(input: PreparedCreateClass) {
    return this.store.database.transaction(() => {
      const { context, centerId, classId, displayName } = input;
      this.store.requireScope(context, centerId);
      const seedKey = `governance:${classId}`;
      if (
        this.store.database.readOne("SELECT id FROM marea_classes WHERE id = ?1 OR seed_key = ?2", [
          classId,
          seedKey,
        ]) !== undefined
      )
        governanceConflict();
      this.store.database.execute(
        "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
        [classId, seedKey, displayName],
      );
      this.store.database.execute(
        `INSERT INTO marea_governance_classes (class_id, center_id, version, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?4)`,
        [classId, centerId, context.generatedVersion, context.now],
      );
      this.store.audit(context, centerId, "class-create", classId);
      return this.store.requireClass(context, centerId, classId);
    });
  }

  commitRenameClass(input: PreparedRenameClass) {
    return this.store.database.transaction(() => {
      const { context, centerId, classId, displayName, expectedVersion } = input;
      this.store.requireVersion(
        this.store.requireClass(context, centerId, classId).version,
        expectedVersion,
      );
      this.store.database.execute("UPDATE marea_classes SET display_name = ?2 WHERE id = ?1", [
        classId,
        displayName,
      ]);
      this.store.database.execute(
        "UPDATE marea_governance_classes SET version = ?2, updated_at = ?3 WHERE class_id = ?1",
        [classId, context.generatedVersion, context.now],
      );
      this.store.audit(context, centerId, "class-rename", classId);
      return this.store.requireClass(context, centerId, classId);
    });
  }
}
