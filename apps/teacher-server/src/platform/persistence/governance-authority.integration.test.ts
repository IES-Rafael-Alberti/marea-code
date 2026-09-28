import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafeDisplayNameSchema, UtcTimestampSchema } from "@marea/protocol";
import type { GovernanceCommitContext } from "../../governance/authority.js";
import {
  governanceFixture,
  governanceId as id,
  GOVERNANCE_NOW,
} from "./governance-repository.fixture.js";

describe("live governance authority and private operator", () => {
  let f: ReturnType<typeof governanceFixture>;
  let admin: GovernanceCommitContext;
  beforeEach(() => {
    f = governanceFixture();
    f.createCenter("center:a");
    f.createCenter("center:b");
    f.createClass("center:a", "class:a");
    f.createClass("center:b", "class:b");
    admin = f.administrator("center:a", "user:admin");
  });
  afterEach(() => {
    f.database.close();
  });

  it("returns only live granted centers and explicit in-scope associations", () => {
    expect(f.reads.requireAccess(admin)).toEqual({ administrator: true });
    expect(f.reads.listCenters(admin, null).items.map((row) => row.centerId)).toEqual(["center:a"]);
    expect(f.reads.listCenters(admin, id("center:a"))).toEqual({ items: [], nextAfterId: null });
    expect(f.reads.listCenters(f.context(), null).items).toHaveLength(2);
    expect(
      f.reads.listClasses(admin, id("center:a"), null).items.map((row) => row.classId),
    ).toEqual(["class:a"]);
    expect(f.reads.listClasses(admin, id("center:a"), id("class:a")).items).toEqual([]);
    expect(
      f.reads.listAccounts(admin, id("center:a"), null).items.map((row) => row.userId),
    ).toEqual(["user:admin"]);
    expect(f.reads.listAccounts(admin, id("center:a"), id("user:admin")).items).toEqual([]);
    for (const centerId of [id("center:b"), id("center:missing")]) {
      expect(() => f.reads.listAccounts(admin, centerId, null)).toThrow(
        expect.objectContaining({ code: "dashboard.forbidden" }),
      );
      expect(() => f.reads.listClasses(admin, centerId, null)).toThrow(
        expect.objectContaining({ code: "dashboard.forbidden" }),
      );
    }
    expect(() => f.store.requireClass(admin, id("center:a"), id("class:b"))).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
  });

  it.each(["student", "teacher"] as const)(
    "does not trust a cached administrator identity for an ordinary %s",
    (role) => {
      f.createAccount("center:a", "user:ordinary", role, role === "student" ? "class:a" : null);
      f.activate("center:a", "user:ordinary");
      const session = f.session("user:ordinary");
      const forged: GovernanceCommitContext = {
        ...admin,
        authority: {
          kind: "administrator",
          session: {
            ...session,
            identity: { ...session.identity, role: "teacher", classId: "class:a" },
          },
        },
      };
      expect(() => f.reads.requireAccess(forged)).toThrow(
        expect.objectContaining({ code: "dashboard.forbidden" }),
      );
      expect(() =>
        f.classes.commitCreateClass({
          context: forged,
          centerId: id("center:a"),
          classId: id("class:denied"),
          displayName: SafeDisplayNameSchema.parse("Denied"),
        }),
      ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
      expect(
        f.database.readOne("SELECT id FROM marea_classes WHERE id = 'class:denied'"),
      ).toBeUndefined();
    },
  );

  it.each([
    "UPDATE marea_auth_sessions SET revoked_at = '2026-09-12T10:00:00.000Z'",
    "UPDATE marea_auth_sessions SET expires_at = '2026-09-12T10:00:00.000Z'",
    "UPDATE marea_governance_accounts SET state = 'disabled' WHERE user_id = 'user:admin'",
    "UPDATE marea_governance_accounts SET state = 'pending' WHERE user_id = 'user:admin'",
  ])("rejects stale authentication at each later read and commit: %s", (change) => {
    const before = f.database.readAll("SELECT * FROM marea_governance_audit");
    f.database.execute(change);
    expect(() => f.reads.requireAccess(admin)).toThrow(
      expect.objectContaining({ code: "auth.invalid" }),
    );
    expect(() =>
      f.classes.commitCreateClass({
        context: admin,
        centerId: id("center:a"),
        classId: id("class:denied"),
        displayName: SafeDisplayNameSchema.parse("Denied"),
      }),
    ).toThrow(expect.objectContaining({ code: "auth.invalid" }));
    expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
  });

  it("rechecks exact sessions, current administrator grants and expired time", () => {
    if (admin.authority.kind !== "administrator") throw new Error("Expected admin fixture.");
    const session = admin.authority.session;
    expect(() => {
      f.reads.requireAdministrator(session.sessionId, id("center:a"), GOVERNANCE_NOW);
    }).not.toThrow();
    expect(() => {
      f.reads.requireAdministrator(session.sessionId, id("center:b"), GOVERNANCE_NOW);
    }).toThrow();
    expect(() =>
      f.reads.requireSession(session.sessionId, id("user:other"), GOVERNANCE_NOW),
    ).toThrow();
    expect(() =>
      f.reads.requireSession(
        session.sessionId,
        id("user:admin"),
        UtcTimestampSchema.parse("2026-09-12T11:00:00.000Z"),
      ),
    ).toThrow();
    const membership = f.database.readOne(
      "SELECT version FROM marea_center_memberships WHERE center_id = 'center:a' AND user_id = 'user:admin'",
    );
    if (typeof membership?.version !== "string") throw new Error("Expected grant version.");
    const revoked = f.operator.commitSetAdministrator({
      context: f.operatorContext(),
      centerId: id("center:a"),
      userId: id("user:admin"),
      capability: "member",
      expectedVersion: id(membership.version),
    });
    expect(revoked.capability).toBe("member");
    expect(() => f.reads.requireAccess(admin)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(f.reads.requireSession(session.sessionId, id("user:admin"), GOVERNANCE_NOW).role).toBe(
      "teacher",
    );
    expect(() => {
      f.reads.requireAdministrator(session.sessionId, id("center:a"), GOVERNANCE_NOW);
    }).toThrow();
  });

  it("uses bounded binary keyset pages without disclosing foreign rows", () => {
    for (let index = 0; index < 102; index++)
      f.createClass("center:a", `class:page:${String(index).padStart(3, "0")}`);
    const first = f.reads.listClasses(admin, id("center:a"), null);
    expect(first.items).toHaveLength(100);
    expect(first.nextAfterId).toBe(first.items.at(-1)?.classId);
    expect(Object.isFrozen(first.items)).toBe(true);
    const second = f.reads.listClasses(admin, id("center:a"), first.nextAfterId);
    expect(second.items).toHaveLength(3);
    expect(second.nextAfterId).toBeNull();
    const ids = [...first.items, ...second.items].map((row) => row.classId);
    expect(new Set(ids).size).toBe(103);
    expect(ids).not.toContain("class:b");
  });

  it("does not advertise another page when exactly one hundred rows remain", () => {
    for (let index = 0; index < 99; index++)
      f.createClass("center:a", `class:exact:${String(index)}`);
    const result = f.reads.listClasses(admin, id("center:a"), null);
    expect(result.items).toHaveLength(100);
    expect(result.nextAfterId).toBeNull();
  });

  it("denies a live student even if an inconsistent stored center grant says administrator", () => {
    f.createAccount("center:a", "user:student", "student", "class:a");
    f.activate("center:a", "user:student");
    const session = f.session("user:student");
    f.database.execute(
      "UPDATE marea_center_memberships SET capability = 'administrator' WHERE user_id = 'user:student'",
    );
    expect(() =>
      f.reads.requireAccess({ ...admin, authority: { kind: "administrator", session } }),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
  });

  it("continues account, membership and private center pages at their last authorized ID", () => {
    for (let index = 0; index < 101; index++) {
      f.createAccount(
        "center:a",
        `user:page:${String(index).padStart(3, "0")}`,
        "teacher",
        "class:a",
      );
      f.createCenter(`center:page:${String(index).padStart(3, "0")}`);
    }
    const accounts = f.reads.listAccounts(admin, id("center:a"), null);
    expect(accounts.items).toHaveLength(100);
    expect(accounts.nextAfterId).toBe(accounts.items.at(-1)?.userId);
    expect(f.reads.listAccounts(admin, id("center:a"), accounts.nextAfterId).items).toHaveLength(2);
    const scope = { context: admin, centerId: id("center:a"), classId: id("class:a") };
    const members = f.reads.listMemberships(scope, null);
    expect(members.items).toHaveLength(100);
    expect(members.nextAfterId).toBe(members.items.at(-1)?.userId);
    expect(f.reads.listMemberships(scope, members.nextAfterId).items).toHaveLength(1);
    const centers = f.reads.listCenters(f.context(), null);
    expect(centers.items).toHaveLength(100);
    expect(centers.nextAfterId).toBe(centers.items.at(-1)?.centerId);
    expect(f.reads.listCenters(f.context(), centers.nextAfterId).items).toHaveLength(3);
  });

  it("denies unknown private targets without creating implicit centers or grants", () => {
    expect(() =>
      f.operator.commitRenameCenter({
        context: f.operatorContext(),
        centerId: id("center:absent"),
        displayName: SafeDisplayNameSchema.parse("Missing"),
        expectedVersion: id("v:missing"),
      }),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
    expect(() =>
      f.operator.commitSetAdministrator({
        context: f.operatorContext(),
        centerId: id("center:a"),
        userId: id("user:absent"),
        capability: "administrator",
        expectedVersion: id("v:missing"),
      }),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
  });

  it("fails closed after exclusive installation ownership is released", () => {
    const context = f.context();
    const before = f.database.readAll("SELECT * FROM marea_centers");
    f.release();
    expect(() => f.reads.listCenters(context, null)).toThrow("Installation is not owned.");
    expect(() => f.createCenter("center:new")).toThrow("Installation is not owned.");
    expect(() => f.createAccount("center:a", "user:new")).toThrow("Installation is not owned.");
    expect(f.database.readAll("SELECT * FROM marea_centers")).toEqual(before);
  });

  it("checks scope before duplicate targets or foreign class foreign-key constraints", () => {
    expect(() =>
      f.classes.commitCreateClass({
        context: admin,
        centerId: "center:b",
        classId: "class:b",
        displayName: "Duplicate",
      }),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
    const account = {
      context: admin,
      centerId: "center:b",
      userId: "user:admin",
      displayName: "Duplicate",
      login: "user-admin",
      role: "teacher" as const,
      classId: null,
      passwordHash: "inaccessible",
    };
    expect(() => f.accounts.commitCreateAccount(account)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(() =>
      f.accounts.commitCreateAccount({
        ...account,
        centerId: "center:a",
        classId: "class:b",
        userId: "user:new",
        login: "new-user",
      }),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
    expect(() =>
      f.memberships.commitChangeMembership({
        context: admin,
        centerId: "center:a",
        classId: "class:b",
        userId: "user:admin",
        state: "active",
        expectedVersion: null,
      }),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
  });

  it("checks private ownership before inspecting nonexistent or conflicting targets", () => {
    const context = f.operatorContext();
    f.release();
    const operations = [
      () =>
        f.operator.commitRenameCenter({
          context,
          centerId: "center:missing",
          displayName: "Missing",
          expectedVersion: "version:missing",
        }),
      () =>
        f.operator.commitAssociateAccount({
          context,
          centerId: "center:a",
          userId: "user:admin",
          expectedVersion: null,
        }),
      () =>
        f.operator.commitSetAdministrator({
          context,
          centerId: "center:a",
          userId: "user:admin",
          expectedVersion: "version:stale",
          capability: "administrator",
        }),
      () =>
        f.operator.commitProvisionCredential({
          context,
          userId: "user:missing",
          expectedVersion: "version:missing",
          passwordHash: "inaccessible",
        }),
    ];
    for (const operation of operations) expect(operation).toThrow("Installation is not owned.");
  });

  it("refuses a pending teacher grant with its actual association version", () => {
    const account = f.createAccount("center:a", "user:pending");
    expect(() =>
      f.operator.commitSetAdministrator({
        context: f.operatorContext(),
        centerId: "center:a",
        userId: account.userId,
        expectedVersion: account.version,
        capability: "administrator",
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("versions private center changes and refuses duplicate/unknown associations", () => {
    const center = f.createCenter("center:c");
    expect(() => f.createCenter("center:c")).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    const changed = f.operator.commitRenameCenter({
      context: f.operatorContext(),
      centerId: center.centerId,
      displayName: SafeDisplayNameSchema.parse("Changed center"),
      expectedVersion: center.version,
    });
    expect(changed.displayName).toBe("Changed center");
    expect(() =>
      f.operator.commitRenameCenter({
        context: f.operatorContext(),
        centerId: center.centerId,
        displayName: center.displayName,
        expectedVersion: center.version,
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(() =>
      f.operator.commitAssociateAccount({
        context: f.operatorContext(),
        centerId: id("center:a"),
        userId: id("user:admin"),
        expectedVersion: null,
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(() =>
      f.operator.commitAssociateAccount({
        context: f.operatorContext(),
        centerId: id("center:a"),
        userId: id("user:missing"),
        expectedVersion: null,
      }),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
  });
});
