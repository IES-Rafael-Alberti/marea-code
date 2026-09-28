import { describe, expect, it, vi } from "vitest";

import { GovernanceController } from "./governance-controller.js";
import {
  classesResponse,
  clearedPresentationFields,
  expectEmptyPrivateCollections,
  openClass,
} from "./governance-controller-test-support.fixture.js";
import {
  CLASS_A,
  CLASS_B,
  CENTER_A,
  CENTER_B,
  PREVIEW_A,
  USER_A,
  USER_B,
  VERSION_A,
  VERSION_B,
  account,
  classroom,
  controllerClient,
  exchange,
  preview,
} from "./governance-controller.fixture.js";

function failure(code: "conflict" | "uncertain") {
  return Object.assign(new Error(code), { code });
}

describe("governance administrator controller", () => {
  it("starts with a fully empty immutable state and exposes every navigation delegate", async () => {
    const client = controllerClient();
    const changed = vi.fn();
    const controller = new GovernanceController(client, changed);
    expect(controller.state.busy).toBe(false);
    expect(controller.state.availability).toEqual({
      canSelectCenter: false,
      canManageClasses: false,
      canManageAccounts: false,
      canManageMemberships: false,
      canExchangeClass: false,
    });
    for (const field of clearedPresentationFields) {
      expect(controller.state[field]).toBeNull();
    }
    expect(controller.state.problem).toBeNull();
    expectEmptyPrivateCollections(controller.state);
    expect(controller.state.centersLoaded).toBe(false);
    expect(controller.state.classesLoaded).toBe(false);
    expect(controller.state.accountsLoaded).toBe(false);
    expect(controller.state.membershipsLoaded).toBe(false);
    expect(controller.state.classRevisionLoaded).toBe(false);
    await controller.loadAccess();
    expect(controller.state.access?.administrator).toBe(true);
    await controller.loadCenters();
    expect(controller.state.centers).toHaveLength(2);
    await controller.selectCenter(CENTER_A);
    await controller.loadClasses();
    await controller.loadAccounts();
    expect(controller.state.classesLoaded).toBe(true);
    expect(controller.state.accountsLoaded).toBe(true);
    await controller.selectCenter(CENTER_B);
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    client.memberships.mockClear();
    client.classRevision.mockClear();
    await controller.loadMemberships();
    await controller.loadClassRevision();
    expect(client.memberships).toHaveBeenCalledTimes(1);
    expect(client.classRevision).toHaveBeenCalledTimes(1);
    expect(controller.state.membershipsLoaded).toBe(true);
    expect(controller.state.classRevisionLoaded).toBe(true);
    expect(changed).toHaveBeenCalled();
    controller.dispose();
  });

  it("covers no-selection guards, explicit navigation cancellation and disposal", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    await controller.loadAccess();
    await controller.loadCenters();
    await controller.loadClasses();
    await controller.loadAccounts();
    await controller.selectCenter("not-an-id");
    await controller.selectClass("not-an-id");
    controller.selectAccount("not-an-id");
    await controller.confirmCenterSwitch(false);
    await controller.confirmCenterSwitch(true);
    await controller.confirmClassSwitch(false);
    await controller.confirmClassSwitch(true);
    controller.confirmAccountSwitch(false);
    controller.confirmAccountSwitch(true);
    controller.editClass("No class");
    await controller.createClass("bad", "");
    await controller.renameClass();
    controller.editAccount("No account");
    await controller.createAccount({
      userId: "bad",
      displayName: "",
      login: "",
      role: "teacher",
      classId: null,
    });
    await controller.renameAccount();
    await controller.changeAccountState("disabled");
    await controller.changeMembership("bad", "revoked");
    await controller.revokeSessions();
    await controller.exportClass();
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    await controller.confirmClassImport();
    await controller.cancelClassImport();
    await controller.reload();
    controller.dispose();
    await controller.load();
    expect(controller.state.problem).toBeNull();
  });

  it("loads access and switches between two centers while retaining scoped lists", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    await controller.load();
    expect(controller.state.access?.administrator).toBe(true);
    expect(controller.state.centers.map((item) => item.centerId)).toEqual([CENTER_A, CENTER_B]);

    await controller.selectCenter(CENTER_A);
    expect(controller.state).toMatchObject({
      centerId: CENTER_A,
      classes: [classroom(CLASS_A, CENTER_A)],
      accounts: [account(USER_A, CENTER_A)],
    });
    await controller.selectCenter(CENTER_B);
    expect(controller.state).toMatchObject({
      centerId: CENTER_B,
      classes: [classroom(CLASS_B, CENTER_B)],
      accounts: [account(USER_B, CENTER_B)],
      classId: null,
      accountId: null,
    });
  });

  it("discards late list responses after a center switch and enforces cursor progression", async () => {
    const client = controllerClient();
    let resolveClasses: ((value: ReturnType<typeof classroom>[]) => void) | undefined;
    client.classes.mockImplementation(({ centerId }: { centerId: string }) => {
      if (centerId === CENTER_A) {
        return new Promise((resolve) => {
          resolveClasses = resolve;
        });
      }
      return Promise.resolve({
        protocolVersion: "0.1" as const,
        requestId: "request:controller",
        kind: "governance-classes-response" as const,
        items: [classroom(CLASS_B, CENTER_B)],
        nextAfterId: null,
      });
    });
    const controller = new GovernanceController(client, vi.fn());
    await controller.load();
    const loadingA = controller.selectCenter(CENTER_A);
    const loadingB = controller.selectCenter(CENTER_B);
    resolveClasses?.([classroom(CLASS_A, CENTER_A)]);
    await Promise.all([loadingA, loadingB]);
    expect(controller.state.centerId).toBe(CENTER_B);
    expect(controller.state.classes).toEqual([classroom(CLASS_B, CENTER_B)]);
  });

  it("records read failures without replacing state and ignores unknown account targets", async () => {
    const client = controllerClient();
    client.classes.mockRejectedValueOnce(new Error("offline"));
    client.classRevision.mockRejectedValueOnce(new Error("revision unavailable"));
    const controller = new GovernanceController(client, vi.fn());
    await controller.load();
    await controller.selectCenter(CENTER_A);
    client.classes.mockRejectedValueOnce(new Error("offline again"));
    await controller.loadClasses();
    expect(controller.state.problem).toBe("load");
    await controller.selectClass(CLASS_A);
    controller.selectAccount(USER_B);
    expect(controller.state.accountId).toBeNull();
  });

  it("keeps account drafts through readback and reports scoped center/class load failures", async () => {
    const { client, controller } = await openClass();
    controller.selectAccount(USER_A);
    controller.editAccount("Unsaved teacher");
    client.accounts.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-accounts-response",
      items: [account(USER_A, CENTER_A, "Server teacher")],
      nextAfterId: null,
    });
    await controller.reload();
    expect(controller.state.accountRecovery?.displayName).toBe("Server teacher");
    expect(controller.state.accountDraft?.displayName).toBe("Unsaved teacher");
    controller.acceptReadback();
    expect(controller.state.accountDraft).toBeNull();

    client.accounts.mockRejectedValueOnce(new Error("center unavailable"));
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    expect(controller.state.problem).toBe("load");
    client.classRevision.mockRejectedValueOnce(new Error("class unavailable"));
    await controller.selectClass(CLASS_B);
    expect(controller.state.problem).toBe("load");
  });

  it("retains drafts across conflict and uncertain writes until explicit readback", async () => {
    const { client, controller } = await openClass();
    controller.editClass("Unsaved class");
    client.renameClass.mockRejectedValueOnce(failure("conflict"));
    await controller.renameClass();
    expect(controller.state.classDraft?.displayName).toBe("Unsaved class");
    expect(controller.state.problem).toBe("conflict");

    client.renameClass.mockRejectedValueOnce(failure("uncertain"));
    await controller.renameClass();
    expect(controller.state.classDraft?.displayName).toBe("Unsaved class");
    expect(controller.state.problem).toBe("uncertain");

    client.renameClass.mockRejectedValueOnce(new Error("unknown outcome"));
    await controller.renameClass();
    expect(controller.state.problem).toBe("load");

    client.classes.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-classes-response",
      items: [classroom(CLASS_A, CENTER_A, "Server class")],
      nextAfterId: null,
    });
    await controller.reload();
    expect(controller.state.classRecovery?.displayName).toBe("Server class");
    expect(controller.state.classDraft?.displayName).toBe("Unsaved class");
    controller.acceptReadback();
    expect(controller.state.classDraft).toBeNull();
    expect(controller.state.problem).toBeNull();
  });

  it("adopts successful class and account writes and stages cancellable switches", async () => {
    const { client, controller } = await openClass();
    client.classes.mockResolvedValueOnce(classesResponse([classroom(CLASS_A), classroom(CLASS_B)]));
    await controller.loadClasses();
    controller.editClass("Saved class");
    await controller.renameClass();
    expect(controller.state.classDraft).toBeNull();
    controller.selectAccount(USER_A);
    controller.editAccount("Saved teacher");
    controller.confirmAccountSwitch(false);
    controller.confirmAccountSwitch(true);
    controller.editClass("Another class");
    await controller.selectClass(CLASS_B);
    expect(controller.state.pendingClassId).toBe(CLASS_B);
    await controller.confirmClassSwitch(false);
    expect(controller.state.classId).toBe(CLASS_A);
    expect(client.renameClass).toHaveBeenCalledTimes(1);
  });

  it("uses loaded versions for account, membership, session and create actions", async () => {
    const { client, controller } = await openClass();
    controller.selectAccount(USER_A);
    controller.editAccount("Renamed teacher");
    await controller.renameAccount();
    expect(client.renameAccount).toHaveBeenCalledWith(
      {
        centerId: CENTER_A,
        userId: USER_A,
        displayName: "Renamed teacher",
        expectedVersion: VERSION_A,
      },
      expect.any(AbortSignal),
    );
    await controller.changeAccountState("disabled");
    await controller.revokeSessions();
    client.changeMembership.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-membership-changed",
      membership: {
        userId: "user:new",
        classId: CLASS_A,
        centerId: CENTER_A,
        role: "teacher",
        state: "active",
        version: VERSION_B,
      },
    });
    await controller.changeMembership(USER_A, "revoked");
    await controller.changeMembership("user:new", "active");
    client.createClass.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-class-created",
      classroom: classroom("class:new", CENTER_A, "New class"),
    });
    await controller.createClass("class:new", "New class");
    expect(controller.state.classes.some((item) => item.classId === "class:new")).toBe(true);
    controller.resumeClassCreateDraft(CENTER_A, "class:new");
    expect(controller.state.classCreateDraft).toBeNull();
    client.createAccount.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-account-created",
      account: account("user:new", CENTER_A, "New teacher"),
    });
    await controller.createAccount({
      userId: "user:new",
      displayName: "New teacher",
      login: "new-teacher",
      role: "teacher",
      classId: null,
    });
    expect(controller.state.accounts.some((item) => item.userId === "user:new")).toBe(true);
    controller.resumeAccountCreateDraft(CENTER_A, "user:new");
    expect(controller.state.accountCreateDraft).toBeNull();
    expect(client.changeAccountState).toHaveBeenCalledWith(
      { centerId: CENTER_A, userId: USER_A, state: "disabled", expectedVersion: VERSION_A },
      expect.any(AbortSignal),
    );
    expect(client.revokeSessions).toHaveBeenCalledWith(
      { centerId: CENTER_A, userId: USER_A, expectedVersion: VERSION_A },
      expect.any(AbortSignal),
    );
    expect(client.changeMembership).toHaveBeenCalledWith(
      {
        centerId: CENTER_A,
        classId: CLASS_A,
        userId: USER_A,
        state: "revoked",
        expectedVersion: VERSION_A,
      },
      expect.any(AbortSignal),
    );
    expect(client.createClass).toHaveBeenCalledWith(
      { centerId: CENTER_A, classId: "class:new", displayName: "New class", expectedVersion: null },
      expect.any(AbortSignal),
    );
    expect(client.createAccount).toHaveBeenCalledWith(
      {
        centerId: CENTER_A,
        userId: "user:new",
        displayName: "New teacher",
        login: "new-teacher",
        role: "teacher",
        classId: null,
        expectedVersion: null,
      },
      expect.any(AbortSignal),
    );
  });

  it("exports, previews, confirms and cancels an import without implicit retry", async () => {
    const { client, controller } = await openClass();
    await controller.exportClass();
    expect(controller.state.exportedPackage).toEqual(exchange);
    await controller.previewClassImport();
    controller.setImportPackage(exchange);
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    expect(client.previewClassImport).toHaveBeenCalledWith(
      expect.objectContaining({
        centerId: CENTER_A,
        classId: CLASS_A,
        expectedTeachingVersion: VERSION_A,
      }),
      expect.any(AbortSignal),
    );
    await controller.cancelClassImport();
    expect(client.cancelClassImport).toHaveBeenCalledWith(
      { centerId: CENTER_A, classId: CLASS_A, previewId: PREVIEW_A },
      expect.any(AbortSignal),
    );
    expect(controller.state.importPreview).toBeNull();
    await controller.previewClassImport();
    await controller.confirmClassImport();
    expect(client.confirmClassImport).toHaveBeenCalledWith(
      { centerId: CENTER_A, classId: CLASS_A, previewId: PREVIEW_A },
      expect.any(AbortSignal),
    );
    expect(controller.state.currentTeachingVersion).toBe(VERSION_B);
    expect(controller.state.importPackage).toBeNull();
  });

  it("blocks expired confirmation and leaves preview state available for explicit cancellation", async () => {
    let now = Date.parse("2025-01-01T00:00:00Z");
    const client = controllerClient();
    client.previewClassImport.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-class-import-previewed",
      preview: preview("2024-12-31T00:00:00Z"),
    });
    const controller = new GovernanceController(client, vi.fn(), () => now);
    await controller.load();
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    await controller.confirmClassImport();
    expect(controller.state.importPreviewExpired).toBe(true);
    expect(client.confirmClassImport).not.toHaveBeenCalled();
    now += 1_000;
    await controller.cancelClassImport();
    expect(controller.state.importPreview).toBeNull();
  });
});
