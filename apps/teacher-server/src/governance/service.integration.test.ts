import * as P from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { governanceServiceFixture, governanceEnvelope } from "./service.fixture.js";

describe("administrator service boundary over live governance repositories", () => {
  let f: ReturnType<typeof governanceServiceFixture>;
  beforeEach(() => {
    f = governanceServiceFixture();
  });
  afterEach(() => {
    f.database.close();
  });
  const centerId = "center:a";
  const envelope = governanceEnvelope;

  it("denies foreign account creation before issuing or hashing any credential", async () => {
    let hashes = 0;
    f.beforeHash(() => {
      hashes++;
      return Promise.resolve();
    });
    await expect(
      f.service.createAccount(
        f.session,
        P.GovernanceCreateAccountRequestSchema.parse({
          ...envelope("governance-account-create"),
          centerId: "center:b",
          userId: "user:new",
          displayName: "New",
          login: "new-account",
          role: "teacher",
          classId: null,
          expectedVersion: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
    expect(hashes).toBe(0);
  });

  it("returns exact versioned access and paged class, account, center and membership projections", async () => {
    const access = P.GovernanceAccessQuerySchema.parse(envelope("governance-access-query"));
    expect(await f.service.access(f.session, access)).toEqual({
      ...access,
      kind: "governance-access-response",
      access: { administrator: true },
    });
    const centers = await f.service.centers(
      f.session,
      P.GovernanceCentersQuerySchema.parse({
        ...envelope("governance-centers-query"),
        afterId: null,
      }),
    );
    expect(centers.items.map((center) => center.centerId)).toEqual([centerId]);
    const classes = await f.service.classes(
      f.session,
      P.GovernanceClassesQuerySchema.parse({
        ...envelope("governance-classes-query"),
        centerId,
        afterId: null,
      }),
    );
    expect(classes.items.map((classroom) => classroom.classId)).toEqual([
      "class:a",
      "class:second",
    ]);
    const accounts = await f.service.accounts(
      f.session,
      P.GovernanceAccountsQuerySchema.parse({
        ...envelope("governance-accounts-query"),
        centerId,
        afterId: null,
      }),
    );
    expect(accounts.items.map((account) => account.userId)).toEqual(["user:admin"]);
    expect(
      await f.service.memberships(
        f.session,
        P.GovernanceMembershipsQuerySchema.parse({
          ...envelope("governance-memberships-query"),
          centerId,
          classId: "class:a",
          afterId: null,
        }),
      ),
    ).toMatchObject({ items: [], nextAfterId: null });
    const before = f.database.readAll("SELECT * FROM marea_governance_audit");
    await expect(
      f.service.classes(
        f.session,
        P.GovernanceClassesQuerySchema.parse({
          ...envelope("governance-classes-query"),
          centerId: "center:b",
          afterId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
    expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
  });

  it("reads the current teaching revision without materializing or auditing", async () => {
    const request = P.GovernanceClassRevisionQuerySchema.parse({
      ...envelope("governance-class-revision-query"),
      centerId,
      classId: "class:a",
    });
    const before = {
      audit: f.database.readAll("SELECT * FROM marea_governance_audit"),
      revisions: f.database.readAll("SELECT * FROM marea_class_teaching_revisions"),
      current: f.database.readAll("SELECT * FROM marea_current_class_teaching"),
      previews: f.database.readAll("SELECT * FROM marea_class_exchange_previews"),
    };
    await expect(f.service.classRevision(f.session, request)).resolves.toEqual({
      ...request,
      kind: "governance-class-revision-response",
      centerId,
      classId: "class:a",
      teachingVersion: null,
    });
    expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before.audit);
    expect(f.database.readAll("SELECT * FROM marea_class_teaching_revisions")).toEqual(
      before.revisions,
    );
    expect(f.database.readAll("SELECT * FROM marea_current_class_teaching")).toEqual(
      before.current,
    );
    expect(f.database.readAll("SELECT * FROM marea_class_exchange_previews")).toEqual(
      before.previews,
    );
    const missing = P.GovernanceClassRevisionQuerySchema.parse({
      ...envelope("governance-class-revision-query"),
      centerId,
      classId: "class:missing",
    });
    const foreign = P.GovernanceClassRevisionQuerySchema.parse({
      ...envelope("governance-class-revision-query"),
      centerId: "center:b",
      classId: "class:b",
    });
    await expect(f.service.classRevision(f.session, missing)).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    await expect(f.service.classRevision(f.session, foreign)).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
  });

  it("creates/renames classes and accounts, changes membership/state and revokes sessions with safe response kinds", async () => {
    const created = await f.service.createClass(
      f.session,
      P.GovernanceCreateClassRequestSchema.parse({
        ...envelope("governance-class-create"),
        centerId,
        classId: "class:new",
        displayName: "New",
        expectedVersion: null,
      }),
    );
    expect(created.kind).toBe("governance-class-created");
    const renamedClass = await f.service.renameClass(
      f.session,
      P.GovernanceRenameClassRequestSchema.parse({
        ...envelope("governance-class-rename"),
        centerId,
        classId: created.classroom.classId,
        displayName: "Renamed",
        expectedVersion: created.classroom.version,
      }),
    );
    expect(renamedClass.classroom.displayName).toBe("Renamed");
    const createdAccount = await f.service.createAccount(
      f.session,
      P.GovernanceCreateAccountRequestSchema.parse({
        ...envelope("governance-account-create"),
        centerId,
        userId: "user:new",
        displayName: "New teacher",
        login: "new-teacher",
        role: "teacher",
        classId: null,
        expectedVersion: null,
      }),
    );
    expect(createdAccount.account.state).toBe("pending");
    const active = f.activate(centerId, "user:new");
    const renamed = await f.service.renameAccount(
      f.session,
      P.GovernanceRenameAccountRequestSchema.parse({
        ...envelope("governance-account-rename"),
        centerId,
        userId: "user:new",
        displayName: "Renamed teacher",
        expectedVersion: active.version,
      }),
    );
    expect(renamed.kind).toBe("governance-account-renamed");
    const membership = await f.service.changeMembership(
      f.session,
      P.GovernanceChangeMembershipRequestSchema.parse({
        ...envelope("governance-membership-change"),
        centerId,
        userId: "user:new",
        classId: "class:new",
        state: "active",
        expectedVersion: null,
      }),
    );
    expect(membership.membership.role).toBe("teacher");
    const revoked = await f.service.revokeSessions(
      f.session,
      P.GovernanceRevokeSessionsRequestSchema.parse({
        ...envelope("governance-sessions-revoke"),
        centerId,
        userId: "user:new",
        expectedVersion: renamed.account.version,
      }),
    );
    const disabled = await f.service.changeAccountState(
      f.session,
      P.GovernanceChangeAccountStateRequestSchema.parse({
        ...envelope("governance-account-state-change"),
        centerId,
        userId: "user:new",
        state: "disabled",
        expectedVersion: revoked.revocation.version,
      }),
    );
    expect(disabled.account.state).toBe("disabled");
    expect(createdAccount.account).not.toHaveProperty("passwordHash");
  });

  it("rejects mismatched kinds, unknown keys, oversized data and forged authority fields", async () => {
    const access = P.GovernanceAccessQuerySchema.parse(envelope("governance-access-query"));
    const centers = P.GovernanceCentersQuerySchema.parse({
      ...envelope("governance-centers-query"),
      afterId: null,
    });
    await expect(f.service.access(f.session, centers as never)).rejects.toMatchObject({
      code: "invalid-request",
    });
    for (const extra of [{ authority: "operator" }, { bogus: true }, { centerId: "center:a" }]) {
      await expect(f.service.access(f.session, { ...access, ...extra })).rejects.toThrow();
    }
    await expect(
      f.service.access(f.session, { ...access, requestId: "x".repeat(65537) } as never),
    ).rejects.toThrow();
  });

  it.each(["grant", "session", "account", "expiry"])(
    "rechecks %s after preparing an inaccessible pending hash",
    async (target) => {
      const before = f.database.readAll("SELECT * FROM marea_governance_audit");
      f.beforeHash(() => {
        if (target === "grant")
          f.database.execute(
            "UPDATE marea_center_memberships SET capability = 'member' WHERE user_id = 'user:admin'",
          );
        if (target === "session")
          f.database.execute(
            "UPDATE marea_auth_sessions SET revoked_at = '2026-09-12T10:01:00.000Z'",
          );
        if (target === "account")
          f.database.execute(
            "UPDATE marea_governance_accounts SET state = 'disabled' WHERE user_id = 'user:admin'",
          );
        if (target === "expiry") f.advance("2026-09-12T12:00:00.000Z");
        return Promise.resolve();
      });
      await expect(
        f.service.createAccount(
          f.session,
          P.GovernanceCreateAccountRequestSchema.parse({
            ...envelope("governance-account-create"),
            centerId,
            userId: "user:denied",
            displayName: "Denied",
            login: "denied",
            role: "teacher",
            classId: null,
            expectedVersion: null,
          }),
        ),
      ).rejects.toThrow();
      expect(
        f.database.readOne("SELECT id FROM marea_users WHERE id = 'user:denied'"),
      ).toBeUndefined();
      expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
    },
  );
});
