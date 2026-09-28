import * as P from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  governanceServiceFixture,
  governanceEnvelope,
  exchangePackage,
} from "./service.fixture.js";
import type { GovernanceSession } from "./authority.js";

type Fixture = ReturnType<typeof governanceServiceFixture>;
type Operation = (fixture: Fixture, session: GovernanceSession) => Promise<P.GovernanceResponse>;
const envelope = governanceEnvelope;
const scoped = { centerId: "center:a", classId: "class:a" };
const edit = { centerId: "center:a", userId: "user:target", expectedVersion: "revision:target" };
const operations: Readonly<Record<string, Operation>> = {
  access: (f, session) =>
    f.service.access(
      session,
      P.GovernanceAccessQuerySchema.parse(envelope("governance-access-query")),
    ),
  centers: (f, session) =>
    f.service.centers(
      session,
      P.GovernanceCentersQuerySchema.parse({
        ...envelope("governance-centers-query"),
        afterId: null,
      }),
    ),
  classes: (f, session) =>
    f.service.classes(
      session,
      P.GovernanceClassesQuerySchema.parse({
        ...envelope("governance-classes-query"),
        centerId: scoped.centerId,
        afterId: null,
      }),
    ),
  accounts: (f, session) =>
    f.service.accounts(
      session,
      P.GovernanceAccountsQuerySchema.parse({
        ...envelope("governance-accounts-query"),
        centerId: scoped.centerId,
        afterId: null,
      }),
    ),
  memberships: (f, session) =>
    f.service.memberships(
      session,
      P.GovernanceMembershipsQuerySchema.parse({
        ...envelope("governance-memberships-query"),
        ...scoped,
        afterId: null,
      }),
    ),
  classRevision: (f, session) =>
    f.service.classRevision(
      session,
      P.GovernanceClassRevisionQuerySchema.parse({
        ...envelope("governance-class-revision-query"),
        ...scoped,
      }),
    ),
  createClass: (f, session) =>
    f.service.createClass(
      session,
      P.GovernanceCreateClassRequestSchema.parse({
        ...envelope("governance-class-create"),
        ...scoped,
        classId: "class:new",
        displayName: "New class",
        expectedVersion: null,
      }),
    ),
  renameClass: (f, session) =>
    f.service.renameClass(
      session,
      P.GovernanceRenameClassRequestSchema.parse({
        ...envelope("governance-class-rename"),
        ...scoped,
        displayName: "Renamed class",
        expectedVersion: "revision:target",
      }),
    ),
  createAccount: (f, session) =>
    f.service.createAccount(
      session,
      P.GovernanceCreateAccountRequestSchema.parse({
        ...envelope("governance-account-create"),
        centerId: scoped.centerId,
        userId: "user:new",
        displayName: "New teacher",
        login: "new-teacher",
        role: "teacher",
        classId: null,
        expectedVersion: null,
      }),
    ),
  renameAccount: (f, session) =>
    f.service.renameAccount(
      session,
      P.GovernanceRenameAccountRequestSchema.parse({
        ...envelope("governance-account-rename"),
        ...edit,
        displayName: "Renamed teacher",
      }),
    ),
  changeAccountState: (f, session) =>
    f.service.changeAccountState(
      session,
      P.GovernanceChangeAccountStateRequestSchema.parse({
        ...envelope("governance-account-state-change"),
        ...edit,
        state: "disabled",
      }),
    ),
  changeMembership: (f, session) =>
    f.service.changeMembership(
      session,
      P.GovernanceChangeMembershipRequestSchema.parse({
        ...envelope("governance-membership-change"),
        ...scoped,
        userId: "user:target",
        expectedVersion: null,
        state: "active",
      }),
    ),
  revokeSessions: (f, session) =>
    f.service.revokeSessions(
      session,
      P.GovernanceRevokeSessionsRequestSchema.parse({
        ...envelope("governance-sessions-revoke"),
        ...edit,
      }),
    ),
  exportClass: (f, session) =>
    f.service.exportClass(
      session,
      P.GovernanceExportClassRequestSchema.parse({
        ...envelope("governance-class-export"),
        ...scoped,
        expectedTeachingVersion: "revision:target",
      }),
    ),
  previewClassImport: (f, session) =>
    f.service.previewClassImport(
      session,
      P.GovernancePreviewClassImportRequestSchema.parse({
        ...envelope("governance-class-import-preview"),
        ...scoped,
        expectedTeachingVersion: null,
        package: exchangePackage,
      }),
    ),
  confirmClassImport: (f, session) =>
    f.service.confirmClassImport(
      session,
      P.GovernanceConfirmClassImportRequestSchema.parse({
        ...envelope("governance-class-import-confirm"),
        ...scoped,
        previewId: "preview:target",
      }),
    ),
  cancelClassImport: (f, session) =>
    f.service.cancelClassImport(
      session,
      P.GovernanceCancelClassImportRequestSchema.parse({
        ...envelope("governance-class-import-cancel"),
        ...scoped,
        previewId: "preview:target",
      }),
    ),
};

describe("every browser-independent governance operation rechecks the live actor", () => {
  let f: Fixture;
  beforeEach(() => {
    f = governanceServiceFixture();
  });
  afterEach(() => {
    f.database.close();
  });

  function actor(kind: string): GovernanceSession {
    if (kind === "foreign-admin") {
      const context = f.administrator("center:b", "user:foreign-admin");
      if (context.authority.kind !== "administrator") throw new Error("Expected an administrator");
      return context.authority.session;
    }
    if (kind === "student" || kind === "teacher") {
      const account = f.createAccount("center:a", "user:ordinary", kind, "class:a");
      f.activate("center:a", account.userId);
      f.identities.createSession({
        userId: account.userId,
        sessionId: "session:ordinary",
        tokenHash: "ordinary-token",
        issuedAt: f.admin.now,
        expiresAt: f.session.expiresAt,
      });
      return {
        sessionId: "session:ordinary",
        expiresAt: f.session.expiresAt,
        identity: f.repository.requireSession("session:ordinary", account.userId, f.admin.now),
      };
    }
    if (kind === "revoked")
      f.database.execute("UPDATE marea_auth_sessions SET revoked_at = issued_at");
    if (kind === "expired") f.advance("2026-09-12T11:00:00.000Z");
    if (kind === "disabled" || kind === "pending")
      f.database.execute(
        "UPDATE marea_governance_accounts SET state = ?1 WHERE user_id = 'user:admin'",
        [kind],
      );
    return f.session;
  }

  for (const [name, operation] of Object.entries(operations)) {
    const actors = [
      "student",
      "teacher",
      "revoked",
      "expired",
      "disabled",
      "pending",
      ...(name === "access" || name === "centers" ? [] : ["foreign-admin"]),
    ];
    it.each(actors)(
      `${name} denies %s before returning target data or writing state`,
      async (kind) => {
        const session = actor(kind);
        const before = f.database.readAll("SELECT * FROM marea_governance_audit");
        await expect(operation(f, session)).rejects.toMatchObject({
          code:
            kind === "expired" || kind === "revoked" || kind === "disabled" || kind === "pending"
              ? "auth.invalid"
              : "dashboard.forbidden",
        });
        expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
        expect(f.database.readAll("SELECT * FROM marea_class_exchange_previews")).toEqual([]);
      },
    );
  }
});
