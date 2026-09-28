import { GovernanceClassImportPreviewedResponseSchema, RequestIdSchema } from "@marea/protocol";
import type {
  GovernanceClassesResponse,
  GovernancePreviewClassImportResponse,
  GovernanceConfirmClassImportResponse,
  GovernanceRenameClassResponse,
  GovernanceRevokeSessionsResponse,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import {
  clearedPresentationFields,
  accountsResponse,
  classesResponse,
  expectEmptyPrivateCollections,
  openClass,
} from "./governance-controller-test-support.fixture.js";
import { deferred } from "./governance-controller-test-support.fixture.js";
import {
  CLASS_A,
  CENTER_A,
  CENTER_B,
  CLASS_B,
  USER_A,
  USER_B,
  VERSION_A,
  VERSION_B,
  account,
  classroom,
  exchange,
  preview,
} from "./governance-controller.fixture.js";

const REQUEST_ID = RequestIdSchema.parse("request:controller");

describe("governance administrator controller repair regressions", () => {
  it("fails closed on access revocation and ignores already-dispatched private reads", async () => {
    const { client, controller } = await openClass();
    const classes = deferred<GovernanceClassesResponse>();
    client.classes.mockImplementationOnce(() => classes.promise);
    const loading = controller.loadClasses();
    client.access.mockRejectedValueOnce(Object.assign(new Error("revoked"), { code: "forbidden" }));
    await controller.loadAccess();
    classes.resolve(classesResponse([classroom(CLASS_A, CENTER_A)]));
    await loading;
    expect(controller.state.access).toBeNull();
    expect(controller.state.centerId).toBeNull();
    expect(controller.state.classes).toEqual([]);
    expect(controller.state.classId).toBeNull();
    expect(controller.state.availability.canManageClasses).toBe(false);
    for (const field of clearedPresentationFields) {
      expect(controller.state[field]).toBeNull();
    }
    expect(controller.state.problem).toBe("forbidden");
    expectEmptyPrivateCollections(controller.state);
  });

  it("fails closed when a stale-context request reports revoked authorization", async () => {
    const { client, controller } = await openClass();
    const classes = deferred<GovernanceClassesResponse>();
    client.classes.mockImplementationOnce(() => classes.promise);
    const loading = controller.loadClasses();

    await controller.selectCenter(CENTER_B);
    expect(controller.state.centerId).toBe(CENTER_B);

    classes.reject(Object.assign(new Error("revoked"), { code: "forbidden" }));
    await loading;
    expect(controller.state.access).toBeNull();
    expect(controller.state.centerId).toBeNull();
    expect(controller.state.availability.canManageClasses).toBe(false);
  });

  it("fails closed when a composite class open receives revoked authorization", async () => {
    const { client, controller } = await openClass();
    client.classRevision.mockRejectedValueOnce(
      Object.assign(new Error("revoked during class open"), { code: "forbidden" }),
    );
    await controller.selectCenter(CENTER_B);
    await controller.selectClass(CLASS_B);
    expect(controller.state.access).toBeNull();
    expect(controller.state.centerId).toBeNull();
    expect(controller.state.classId).toBeNull();
    expect(controller.state.availability.canExchangeClass).toBe(false);
  });

  it("invalidates private context when a refreshed access result loses admin access", async () => {
    const { client, controller } = await openClass();
    const classes = deferred<GovernanceClassesResponse>();
    client.classes.mockImplementationOnce(() => classes.promise);
    const loading = controller.loadClasses();
    client.access.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-access-response",
      access: { administrator: false },
    });
    await controller.loadAccess();
    classes.resolve(classesResponse([classroom(CLASS_A, CENTER_A)]));
    await loading;
    expect(controller.state.access?.administrator).toBe(false);
    expect(controller.state.centerId).toBeNull();
    expect(controller.state.classId).toBeNull();
    expect(controller.state.classes).toEqual([]);
    expect(controller.state.availability.canManageClasses).toBe(false);
  });

  it("rejects responses whose resource identity does not match the requested scope", async () => {
    const { client, controller } = await openClass();
    client.classes.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-classes-response",
      items: [classroom(CLASS_A, CENTER_B)],
      nextAfterId: null,
    });
    await controller.loadClasses();
    expect(controller.state.classes[0]?.centerId).toBe(CENTER_A);
    expect(controller.state.problem).toBe("invalid");

    client.classRevision.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-revision-response",
      centerId: CENTER_B,
      classId: CLASS_B,
      teachingVersion: VERSION_B,
    });
    await controller.loadClassRevision();
    expect(controller.state.classRevisionLoaded).toBe(false);
    expect(controller.state.currentTeachingVersion).toBeNull();
    expect(controller.state.problem).toBe("invalid");

    controller.editClass("scope check");
    client.renameClass.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-renamed",
      classroom: classroom(CLASS_A, CENTER_B, "wrong center"),
    });
    await controller.renameClass();
    expect(controller.state.classes[0]?.displayName).not.toBe("wrong center");
    expect(controller.state.problem).toBe("invalid");

    client.accounts.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-accounts-response",
      items: [account(USER_A, CENTER_B)],
      nextAfterId: null,
    });
    await controller.loadAccounts();
    expect(controller.state.accounts[0]?.centerId).toBe(CENTER_A);
    expect(controller.state.problem).toBe("invalid");

    client.memberships.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-memberships-response",
      items: [
        {
          centerId: CENTER_B,
          classId: CLASS_A,
          userId: USER_A,
          role: "teacher",
          state: "active",
          version: VERSION_A,
        },
      ],
      nextAfterId: null,
    });
    await controller.loadMemberships();
    expect(controller.state.memberships[0]?.centerId).toBe(CENTER_A);
    expect(controller.state.problem).toBe("invalid");
  });

  it("records an unknown composite class-open failure without private readback", async () => {
    const { client, controller } = await openClass();
    client.classRevision.mockRejectedValueOnce("unexpected class-open failure");
    await controller.selectCenter(CENTER_B);
    await controller.selectClass(CLASS_B);
    expect(controller.state.centerId).toBe(CENTER_B);
    expect(controller.state.classId).toBe(CLASS_B);
    expect(controller.state.classRevisionLoaded).toBe(false);
    expect(controller.state.problem).toBe("load");
  });

  it("preserves scoped drafts across access refresh while hiding private presentation", async () => {
    const { controller } = await openClass();
    controller.editClass("Preserved class draft");
    await controller.loadAccounts();
    controller.selectAccount(USER_A);
    controller.editAccount("Preserved account draft");
    await controller.loadAccess();
    expect(controller.state.classDraft).toBeNull();
    expect(controller.state.accountDraft).toBeNull();
    expect(controller.state.centerId).toBeNull();

    await controller.loadCenters();
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    expect(controller.state.classDraft?.displayName).toBe("Preserved class draft");
    await controller.loadAccounts();
    controller.selectAccount(USER_A);
    expect(controller.state.accountDraft?.displayName).toBe("Preserved account draft");
  });

  it("keeps class revision adoption alive while selecting an account", async () => {
    const { client, controller } = await openClass();
    client.accounts.mockResolvedValueOnce(
      accountsResponse([account(USER_A, CENTER_A), account(USER_B, CENTER_A)]),
    );
    await controller.loadAccounts();
    const revision = deferred<Awaited<ReturnType<typeof client.classRevision>>>();
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const loading = controller.loadClassRevision();
    controller.selectAccount(USER_B);
    revision.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-revision-response",
      centerId: CENTER_A,
      classId: CLASS_A,
      teachingVersion: VERSION_B,
    });
    await loading;
    expect(controller.state.accountId).toBe(USER_B);
    expect(controller.state.classId).toBe(CLASS_A);
    expect(controller.state.classRevisionLoaded).toBe(true);
    expect(controller.state.currentTeachingVersion).toBe(VERSION_B);
  });

  it("ignores a double click without invalidating the first mutation", async () => {
    const { client, controller } = await openClass();
    controller.editClass("First name");
    const rename = deferred<GovernanceRenameClassResponse>();
    client.renameClass.mockImplementationOnce(() => rename.promise);
    const first = controller.renameClass();
    const second = controller.renameClass();
    expect(client.renameClass).toHaveBeenCalledTimes(1);
    rename.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-renamed",
      classroom: classroom(CLASS_A, CENTER_A, "First name"),
    });
    await Promise.all([first, second]);
    expect(controller.state.classDraft).toBeNull();
    expect(controller.state.classes[0]?.displayName).toBe("First name");
  });

  it("retains a newer draft and rejects a late account result after switching", async () => {
    const { client, controller } = await openClass();
    controller.editClass("First name");
    const rename = deferred<GovernanceRenameClassResponse>();
    client.renameClass.mockImplementationOnce(() => rename.promise);
    const saving = controller.renameClass();
    controller.editClass("Newer name");
    rename.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-renamed",
      classroom: classroom(CLASS_A, CENTER_A, "First name"),
    });
    await saving;
    expect(controller.state.classDraft?.displayName).toBe("Newer name");

    client.accounts.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-accounts-response",
      items: [account(USER_A, CENTER_A), account(USER_B, CENTER_A)],
      nextAfterId: null,
    });
    await controller.loadAccounts();
    controller.selectAccount(USER_A);
    const revoke = deferred<GovernanceRevokeSessionsResponse>();
    client.revokeSessions.mockImplementationOnce(() => revoke.promise);
    const revoking = controller.revokeSessions();
    controller.selectAccount(USER_B);
    revoke.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-sessions-revoked",
      revocation: { userId: USER_A, version: VERSION_B, revokedAt: "2099-01-01T00:00:00Z" },
    });
    await revoking;
    expect(controller.state.accountId).toBe(USER_B);
    expect(controller.state.lastRevocation).toBeNull();
  });

  it("invalidates import previews when the package changes and recovers uncertain creates", async () => {
    const { client, controller } = await openClass();
    controller.setImportPackage(exchange);
    const importing = deferred<GovernancePreviewClassImportResponse>();
    client.previewClassImport.mockImplementationOnce(() => importing.promise);
    const previewing = controller.previewClassImport();
    controller.setImportPackage(null);
    importing.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-import-previewed",
      preview: GovernanceClassImportPreviewedResponseSchema.parse({
        protocolVersion: "0.1",
        requestId: REQUEST_ID,
        kind: "governance-class-import-previewed",
        preview: preview(),
      }).preview,
    });
    await previewing;
    expect(controller.state.importPreview).toBeNull();
    await controller.confirmClassImport();
    expect(client.confirmClassImport).not.toHaveBeenCalled();

    client.createClass.mockRejectedValueOnce(
      Object.assign(new Error("uncertain"), { code: "uncertain" }),
    );
    await controller.createClass("class:new", "New class");
    expect(controller.state.classCreateDraft?.classId).toBe("class:new");
    client.classes.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-classes-response",
      items: [classroom(CLASS_A, CENTER_A), classroom("class:new", CENTER_A, "New class")],
      nextAfterId: null,
    });
    await controller.loadClasses();
    expect(controller.state.classCreateRecovery?.classId).toBe("class:new");
    controller.acceptReadback();
    expect(controller.state.classCreateDraft).toBeNull();
  });

  it("does not confirm a preview after the destination revision changes", async () => {
    const { client, controller } = await openClass();
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    client.classRevision.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-class-revision-response",
      centerId: CENTER_A,
      classId: CLASS_A,
      teachingVersion: VERSION_B,
    });
    await controller.loadClassRevision();
    await controller.confirmClassImport();
    expect(client.confirmClassImport).not.toHaveBeenCalled();
    expect(controller.state.importPreview).toBeNull();
  });

  it("does not let a late confirmation for package A delete later package B", async () => {
    const { client, controller } = await openClass();
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    const confirming = deferred<GovernanceConfirmClassImportResponse>();
    client.confirmClassImport.mockImplementationOnce(() => confirming.promise);
    const pending = controller.confirmClassImport();
    await controller.confirmClassImport();
    const packageB = { ...exchange, source: { displayName: "Package B" } };
    controller.setImportPackage(packageB);
    await controller.cancelClassImport();
    confirming.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-import-confirmed",
      classId: CLASS_A,
      teachingVersion: VERSION_B,
    });
    await pending;
    expect(controller.state.importPackage).toEqual(packageB);
    // The committed import still advances the destination revision.
    expect(controller.state.currentTeachingVersion).toBe(VERSION_B);
    expect(controller.state.importPreview).toBeNull();
    await controller.cancelClassImport();
  });
});
