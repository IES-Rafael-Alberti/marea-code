import { RevisionIdSchema, Sha256DigestSchema, PrincipalRoleSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { AdoptionMap, AdoptionReceipt } from "../../governance/adoption-contracts.js";
import type { Id } from "../../governance/authority.js";
import { governanceConflict } from "./governance-store.js";
import { rowNullableText, rowText } from "./row-parser.boundary.js";
import { GovernanceInventoryBudget } from "./governance-inventory-budget.js";

/** Inventory is relational identity/ownership evidence, never run content. */
export function adoptionInventory(database: SqliteApplicationDatabase, map: AdoptionMap) {
  const classes = new Map(map.classes.map((entry) => [entry.classId, entry.centerId]));
  const accounts = new Map(map.accounts.map((entry) => [entry.userId, entry.ownerCenterId]));
  const missingClasses = new Set<Id>();
  const missingUsers = new Set<Id>();
  const budget = new GovernanceInventoryBudget(database);
  budget.include(map);
  const centerIds = new Set([
    ...classes.values(),
    ...accounts.values(),
    ...map.administrators.map((entry) => entry.centerId),
  ]);
  for (const centerId of [...centerIds].sort()) {
    const center = database.readOne(
      "SELECT id, display_name, version FROM marea_centers WHERE id = ?1",
      [centerId],
    );
    if (center === undefined) governanceConflict();
    budget.include(center);
  }
  const relationships: { userId: Id; classId: Id; role: "teacher" | "student" }[] = [];
  function inspectClasses() {
    for (const entry of map.classes) {
      const row = database.readOne(
        `SELECT classes.id, classes.seed_key, classes.display_name, governed.center_id, governed.version
      FROM marea_classes classes LEFT JOIN marea_governance_classes governed ON governed.class_id = classes.id WHERE classes.id = ?1`,
        [entry.classId],
      );
      if (row === undefined) governanceConflict();
      const owner = rowNullableText(row, "center_id");
      if (owner !== null && owner !== entry.centerId) governanceConflict();
      budget.include(row);
      const users = budget.read(
        `SELECT id FROM marea_users WHERE class_id = ?1
      UNION SELECT teacher_id AS id FROM marea_teacher_classes WHERE class_id = ?1
      UNION SELECT user_id AS id FROM marea_governance_memberships WHERE class_id = ?1 ORDER BY id`,
        entry.classId,
      );
      for (const user of users) {
        const userId = RevisionIdSchema.parse(rowText(user, "id"));
        if (!accounts.has(userId)) missingUsers.add(userId);
      }
    }
  }
  function inspectAccounts() {
    for (const entry of map.accounts) {
      const row = database.readOne(
        `SELECT users.id, users.role, users.class_id, users.display_name, users.login, users.password_hash,
      accounts.owner_center_id, accounts.state, accounts.version FROM marea_users users
      LEFT JOIN marea_governance_accounts accounts ON accounts.user_id = users.id WHERE users.id = ?1`,
        [entry.userId],
      );
      if (row === undefined) governanceConflict();
      const owner = rowNullableText(row, "owner_center_id");
      if (owner !== null && owner !== entry.ownerCenterId) governanceConflict();
      budget.include(row);
      const role = PrincipalRoleSchema.parse(rowText(row, "role"));
      const currentClass = rowNullableText(row, "class_id");
      const teaching = budget.read(
        "SELECT class_id FROM marea_teacher_classes WHERE teacher_id = ?1 ORDER BY class_id",
        entry.userId,
      );
      if (role === "student" && teaching.length !== 0) governanceConflict();
      if (role === "student" && currentClass !== null)
        relationships.push({
          userId: entry.userId,
          classId: RevisionIdSchema.parse(currentClass),
          role,
        });
      for (const assignment of teaching)
        relationships.push({
          userId: entry.userId,
          classId: RevisionIdSchema.parse(rowText(assignment, "class_id")),
          role,
        });
      const history = budget.read(
        "SELECT DISTINCT class_id FROM marea_runs WHERE student_id = ?1 ORDER BY class_id",
        entry.userId,
      );
      const memberships = budget.read(
        "SELECT class_id, center_id, role, state, version FROM marea_governance_memberships WHERE user_id = ?1 ORDER BY class_id",
        entry.userId,
      );
      budget.read(
        "SELECT center_id, capability, state, version FROM marea_center_memberships WHERE user_id = ?1 ORDER BY center_id",
        entry.userId,
      );
      const references = [...teaching, ...history, ...memberships].map((item) =>
        RevisionIdSchema.parse(rowText(item, "class_id")),
      );
      if (currentClass !== null) references.push(RevisionIdSchema.parse(currentClass));
      for (const classId of references) if (!classes.has(classId)) missingClasses.add(classId);
    }
  }
  inspectClasses();
  inspectAccounts();
  for (const grant of map.administrators)
    if (!accounts.has(grant.userId)) missingUsers.add(grant.userId);
  for (const relationship of relationships) {
    if (
      relationship.role === "student" &&
      classes.has(relationship.classId) &&
      classes.get(relationship.classId) !== accounts.get(relationship.userId)
    )
      governanceConflict();
  }
  const receipt: AdoptionReceipt = Object.freeze({
    digest: Sha256DigestSchema.parse(`sha256:${budget.hash.digest("hex")}`),
    classes: map.classes.length,
    accounts: map.accounts.length,
    memberships: relationships.length,
    missingClassIds: Object.freeze([...missingClasses].sort()),
    missingUserIds: Object.freeze([...missingUsers].sort()),
  });
  return { receipt, relationships };
}
