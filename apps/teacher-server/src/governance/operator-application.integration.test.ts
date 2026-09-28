import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createGovernanceOperatorApplication } from "./operator-application.boundary.js";
import { createGovernanceOperatorResources } from "../platform/operator/governance-operator-resources.boundary.js";
import { governanceServiceFixture, exchangePackage } from "./service.fixture.js";
import { GOVERNANCE_NOW } from "../platform/persistence/governance-repository.fixture.js";
import type { OperatorContext } from "./authority.js";

describe("private governance application with real SQLite", () => {
  let f: ReturnType<typeof governanceServiceFixture>;
  let app: ReturnType<typeof createGovernanceOperatorApplication>;
  let context: OperatorContext;
  beforeEach(() => {
    f = governanceServiceFixture();
    const owned = f.operatorContext();
    context = { authority: owned.authority, now: owned.now, requestId: owned.requestId };
    app = createGovernanceOperatorApplication(
      f.dependencies,
      createGovernanceOperatorResources({
        core: f.source,
        centers: new Map(),
        teachers: new Map(),
      }),
    );
  });
  afterEach(() => {
    f.database.close();
  });

  it("creates and renames centers/classes with exact versions and no browser identity", async () => {
    const center = await app.createCenter({
      ...context,
      centerId: "center:new",
      displayName: "New center",
      expectedVersion: null,
    });
    await expect(
      app.createCenter({
        ...context,
        centerId: center.centerId,
        displayName: "Duplicate",
        expectedVersion: null,
      }),
    ).rejects.toMatchObject({ code: "request.conflict" });
    const renamed = await app.renameCenter({
      ...context,
      centerId: center.centerId,
      displayName: "Renamed",
      expectedVersion: center.version,
    });
    expect(renamed.version).not.toBe(center.version);
    const classroom = await app.createClass({
      ...context,
      centerId: center.centerId,
      classId: "class:new",
      displayName: "New class",
      expectedVersion: null,
    });
    expect(
      await app.renameClass({
        ...context,
        centerId: center.centerId,
        classId: classroom.classId,
        displayName: "Renamed class",
        expectedVersion: classroom.version,
      }),
    ).toMatchObject({ displayName: "Renamed class" });
    expect(
      f.database.readAll(
        "SELECT DISTINCT authority, actor_user_id FROM marea_governance_audit WHERE center_id = 'center:new'",
      ),
    ).toEqual([{ authority: "operator", actor_user_id: null }]);
    expect(
      f.database
        .readAll(
          "SELECT operation FROM marea_governance_audit WHERE center_id = 'center:new' ORDER BY sequence",
        )
        .map((row) => row.operation),
    ).toEqual(["center-create", "center-rename", "class-create", "class-rename"]);
  });

  it("creates inaccessible accounts, provisions privately, and manages exact associations and grants", async () => {
    const initialAuditCount = f.database.readAll("SELECT * FROM marea_governance_audit").length;
    const account = await app.createAccount({
      ...context,
      centerId: "center:a",
      userId: "user:new",
      displayName: "New teacher",
      login: "new-teacher",
      role: "teacher",
      classId: null,
      expectedVersion: null,
    });
    expect(account.state).toBe("pending");
    const provisioned = await app.provisionCredential({
      ...context,
      userId: account.userId,
      expectedVersion: account.version,
      password: "private-password",
    });
    expect(Object.keys(provisioned).sort()).toEqual(["userId", "version"]);
    expect(
      f.database.readOne("SELECT password_hash FROM marea_users WHERE id = 'user:new'"),
    ).toEqual({ password_hash: "hashed:private-password" });
    const association = await app.associateAccount({
      ...context,
      centerId: "center:b",
      userId: account.userId,
      expectedVersion: null,
    });
    const grant = await app.setAdministrator({
      ...context,
      centerId: "center:b",
      userId: account.userId,
      capability: "administrator",
      expectedVersion: association.version,
    });
    expect(association).toMatchObject({ capability: "member", state: "active" });
    expect(grant.state).toBe("active");
    expect(grant.capability).toBe("administrator");
    const member = await app.setAdministrator({
      ...context,
      centerId: "center:b",
      userId: account.userId,
      capability: "member",
      expectedVersion: grant.version,
    });
    expect(member.capability).toBe("member");
    const renamed = await app.renameAccount({
      ...context,
      centerId: "center:a",
      userId: account.userId,
      displayName: "Renamed teacher",
      expectedVersion: provisioned.version,
    });
    const membership = await app.changeMembership({
      ...context,
      centerId: "center:a",
      classId: "class:a",
      userId: account.userId,
      state: "active",
      expectedVersion: null,
    });
    expect(renamed).toMatchObject({ displayName: "Renamed teacher" });
    expect(renamed.version).not.toBe(provisioned.version);
    expect(membership.state).toBe("active");
    expect(membership.role).toBe("teacher");
    const revocation = await app.revokeSessions({
      ...context,
      centerId: "center:a",
      userId: account.userId,
      expectedVersion: renamed.version,
    });
    expect(revocation.revokedAt).toBe(GOVERNANCE_NOW);
    expect(
      await app.changeAccountState({
        ...context,
        centerId: "center:a",
        userId: account.userId,
        state: "disabled",
        expectedVersion: revocation.version,
      }),
    ).toMatchObject({ state: "disabled" });
    expect(
      f.database
        .readAll("SELECT * FROM marea_governance_audit")
        .flatMap(Object.values)
        .map(String)
        .join(" "),
    ).not.toContain("private-password");
    expect(
      f.database
        .readAll("SELECT operation FROM marea_governance_audit ORDER BY sequence")
        .slice(initialAuditCount)
        .map((row) => row.operation),
    ).toEqual([
      "account-create",
      "credential-provision",
      "account-associate",
      "administrator-set",
      "administrator-set",
      "account-rename",
      "membership-change",
      "sessions-revoke",
      "account-state",
    ]);
  });

  it("rejects lock loss after hashing without changing credentials or audit", async () => {
    const account = f.createAccount("center:a", "user:pending");
    const before = f.database.readAll("SELECT * FROM marea_governance_audit");
    const commit = vi.fn(f.repository.commitProvisionCredential.bind(f.repository));
    app = createGovernanceOperatorApplication(
      { ...f.dependencies, repository: { ...f.repository, commitProvisionCredential: commit } },
      createGovernanceOperatorResources({
        core: f.source,
        centers: new Map(),
        teachers: new Map(),
      }),
    );
    f.beforeHash(() => {
      f.release();
      return Promise.resolve();
    });
    await expect(
      app.provisionCredential({
        ...context,
        userId: account.userId,
        expectedVersion: account.version,
        password: "private-password",
      }),
    ).rejects.toThrow("Installation is not owned.");
    expect(
      f.database.readOne("SELECT password_hash FROM marea_users WHERE id = 'user:pending'"),
    ).toEqual({ password_hash: "inaccessible:user:pending" });
    expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
    expect(commit).not.toHaveBeenCalled();
  });

  it("validates private payloads before hashing and never accepts browser envelope switches", async () => {
    let hashes = 0;
    f.beforeHash(() => {
      hashes++;
      return Promise.resolve();
    });
    await expect(
      app.provisionCredential({
        ...context,
        userId: "user:admin",
        expectedVersion: "revision:1",
        password: "short",
      }),
    ).rejects.toThrow();
    await expect(
      app.createCenter({
        ...context,
        centerId: "center:bad",
        displayName: "Bad",
        expectedVersion: "revision:old",
      } as never),
    ).rejects.toThrow();
    for (const extra of [
      { kind: "governance-class-create" },
      { protocolVersion: "0.1" },
      { passwordHash: "injected" },
    ]) {
      await expect(
        app.createClass({
          ...context,
          centerId: "center:a",
          classId: "class:bad",
          displayName: "Bad",
          expectedVersion: null,
          ...extra,
        }),
      ).rejects.toMatchObject(
        Object.hasOwn(extra, "passwordHash") ? { name: "ZodError" } : { code: "invalid-request" },
      );
    }
    for (const invalidHeader of [{ now: "invalid-time" }, { requestId: "invalid/id" }]) {
      await expect(
        app.provisionCredential({
          ...context,
          ...invalidHeader,
          userId: "user:admin",
          expectedVersion: "revision:one",
          password: "private-password",
        } as never),
      ).rejects.toThrow();
    }
    expect(hashes).toBe(0);
    expect(
      f.database.readOne("SELECT id FROM marea_classes WHERE id = 'class:bad'"),
    ).toBeUndefined();
  });

  it("imports, exports and cancels as operator, without synthesizing a teacher", async () => {
    const initialAuditCount = f.database.readAll("SELECT * FROM marea_governance_audit").length;
    const scope = { ...context, centerId: "center:a", classId: "class:a" };
    const preview = await app.previewClassImport({
      ...scope,
      expectedTeachingVersion: null,
      package: exchangePackage,
    });
    const result = await app.confirmClassImport({ ...scope, previewId: preview.previewId });
    expect(
      await app.exportClass({ ...scope, expectedTeachingVersion: result.teachingVersion }),
    ).toMatchObject({ classInstructions: exchangePackage.classInstructions });
    expect(
      f.database.readOne("SELECT authority, created_by FROM marea_class_teaching_revisions"),
    ).toEqual({ authority: "operator", created_by: null });
    const next = await app.previewClassImport({
      ...scope,
      expectedTeachingVersion: result.teachingVersion,
      package: exchangePackage,
    });
    expect(await app.cancelClassImport({ ...scope, previewId: next.previewId })).toEqual({
      previewId: next.previewId,
    });
    expect(
      f.database
        .readAll("SELECT operation FROM marea_governance_audit ORDER BY sequence")
        .slice(initialAuditCount)
        .map((row) => row.operation),
    ).toEqual([
      "class-import-preview",
      "class-import-confirm",
      "class-import-preview",
      "class-import-cancel",
    ]);
  });

  it("previews and confirms an explicit empty adoption without writes", async () => {
    const map = { classes: [], accounts: [], administrators: [] };
    const before = f.database.readAll("SELECT * FROM marea_governance_audit");
    const receipt = await app.previewAdoption({ ...context, map });
    expect(await app.confirmAdoption({ ...context, map, digest: receipt.digest })).toEqual(receipt);
    expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
  });
});
