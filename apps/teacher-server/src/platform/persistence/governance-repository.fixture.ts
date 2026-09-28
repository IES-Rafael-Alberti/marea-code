import {
  RequestIdSchema,
  RevisionIdSchema,
  SafeDisplayNameSchema,
  CredentialLoginSchema,
  UtcTimestampSchema,
} from "@marea/protocol";
import { createMigrationCatalog } from "@marea/sqlite-storage/migrations";
import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import type {
  GovernanceCommitContext,
  GovernanceSession,
  InstallationCapability,
} from "../../governance/authority.js";
import { GovernanceStore } from "./governance-store.js";
import { GovernanceReads } from "./governance-reads.js";
import { GovernanceClassMutations } from "./governance-class-mutations.js";
import { GovernanceAccountMutations } from "./governance-account-mutations.js";
import { GovernanceMembershipMutations } from "./governance-membership-mutations.js";
import { GovernanceOperatorMutations, operatorCommit } from "./governance-operator-mutations.js";
import { SqliteIdentityRepository } from "./sqlite-identity-repository.js";
import { withoutDeletionAuthority, type IdentityCreationGuard } from "./identity-creation-guard.js";

export const governanceId = (value: string) => RevisionIdSchema.parse(value);
export const GOVERNANCE_NOW = UtcTimestampSchema.parse("2026-09-12T10:00:00.000Z");
export const GOVERNANCE_EXPIRES = UtcTimestampSchema.parse("2026-09-12T11:00:00.000Z");

export function governanceFixture(
  creationGuard: IdentityCreationGuard = withoutDeletionAuthority(),
) {
  const database = new NodeSqliteTestDatabase();
  for (const migration of createMigrationCatalog()) {
    for (const sql of migration.statements) database.executeScript(sql);
  }
  let sequence = 0;
  let owned = true;
  const installation: InstallationCapability = {
    kind: "exclusive-installation-owner",
    installationRoot: "/synthetic/governance-fixture",
    assertOwned: () => {
      if (!owned) throw new Error("Installation is not owned.");
      return undefined;
    },
  };
  const store = new GovernanceStore(database, () => false, creationGuard);
  const reads = new GovernanceReads(store);
  const classes = new GovernanceClassMutations(store);
  const accounts = new GovernanceAccountMutations(store);
  const memberships = new GovernanceMembershipMutations(store);
  const operator = new GovernanceOperatorMutations(store);
  const identities = new SqliteIdentityRepository(database);
  const operatorContext = () => ({
    authority: installation,
    now: GOVERNANCE_NOW,
    generatedVersion: governanceId(`revision:${String(++sequence)}`),
    requestId: RequestIdSchema.parse(`request:${String(sequence)}`),
  });
  const context = () => operatorCommit(operatorContext());
  const createCenter = (centerId: string) =>
    operator.commitCreateCenter({
      context: operatorContext(),
      centerId: governanceId(centerId),
      displayName: SafeDisplayNameSchema.parse("Center"),
      expectedVersion: null,
    });
  const createClass = (centerId: string, classId: string) =>
    classes.commitCreateClass({
      context: context(),
      centerId: governanceId(centerId),
      classId: governanceId(classId),
      displayName: SafeDisplayNameSchema.parse("Class"),
    });
  const createAccount = (
    centerId: string,
    userId: string,
    role: "teacher" | "student" = "teacher",
    classId: string | null = null,
  ) =>
    accounts.commitCreateAccount({
      context: context(),
      centerId: governanceId(centerId),
      userId: governanceId(userId),
      role,
      classId: classId === null ? null : governanceId(classId),
      displayName: SafeDisplayNameSchema.parse("Person"),
      login: CredentialLoginSchema.parse(userId.replaceAll(":", "-")),
      passwordHash: `inaccessible:${userId}`,
    });
  const activate = (centerId: string, userId: string) =>
    operator.commitProvisionCredential({
      context: operatorContext(),
      userId: governanceId(userId),
      expectedVersion: store.account(context(), governanceId(centerId), governanceId(userId))
        .version,
      passwordHash: `provisioned:${userId}`,
    });
  const session = (userId: string): GovernanceSession => {
    const sessionId = governanceId(`session:${String(++sequence)}`);
    identities.createSession({
      sessionId,
      userId,
      issuedAt: GOVERNANCE_NOW,
      expiresAt: GOVERNANCE_EXPIRES,
      tokenHash: `token:${String(sequence)}`,
    });
    return {
      sessionId,
      expiresAt: GOVERNANCE_EXPIRES,
      identity: reads.requireSession(sessionId, governanceId(userId), GOVERNANCE_NOW),
    };
  };
  const administrator = (centerId: string, userId: string): GovernanceCommitContext => {
    const account = createAccount(centerId, userId);
    activate(centerId, userId);
    operator.commitSetAdministrator({
      context: operatorContext(),
      centerId: governanceId(centerId),
      userId: governanceId(userId),
      capability: "administrator",
      expectedVersion: account.version,
    });
    return { ...context(), authority: { kind: "administrator", session: session(userId) } };
  };
  return {
    database,
    store,
    reads,
    classes,
    accounts,
    memberships,
    operator,
    identities,
    context,
    operatorContext,
    createCenter,
    createClass,
    createAccount,
    activate,
    session,
    administrator,
    release: () => {
      owned = false;
    },
  };
}

export function seedGovernancePilot(
  fixture: ReturnType<typeof governanceFixture>,
): GovernanceCommitContext {
  fixture.createCenter("center:a");
  fixture.createCenter("center:b");
  fixture.createClass("center:a", "class:a");
  fixture.createClass("center:a", "class:second");
  fixture.createClass("center:b", "class:b");
  return fixture.administrator("center:a", "user:admin");
}

export function seedGovernanceHistory(
  fixture: ReturnType<typeof governanceFixture>,
  userId: string,
  classId: string,
) {
  fixture.database.execute(
    'INSERT INTO marea_run_snapshots VALUES (\'snapshot:history\', \'{"private":"historical snapshot"}\', \'{"private":"historical route"}\', ?1)',
    [GOVERNANCE_NOW],
  );
  fixture.database.execute(
    "INSERT INTO marea_runs VALUES ('run:history', ?1, ?2, 'snapshot:history', 'client:history', 'Historical project', 'closed', ?3, ?3, 'student-requested')",
    [userId, classId, GOVERNANCE_NOW],
  );
}
