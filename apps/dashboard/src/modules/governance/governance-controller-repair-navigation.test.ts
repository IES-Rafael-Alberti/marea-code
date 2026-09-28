import { RequestIdSchema } from "@marea/protocol";
import type { GovernanceClassesResponse, GovernanceRenameClassResponse } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { GovernanceController } from "./governance-controller.js";
import {
  accountsResponse,
  classesResponse,
  deferred,
  openClass,
} from "./governance-controller-test-support.fixture.js";
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
  controllerClient,
  exchange,
  preview,
} from "./governance-controller.fixture.js";

const REQUEST_ID = RequestIdSchema.parse("request:controller");

describe("governance administrator controller repair regressions", () => {
  it("clears private context when a refreshed center page removes the selected center", async () => {
    const { client, controller } = await openClass();
    await controller.exportClass();
    client.centers.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-centers-response",
      items: [
        {
          centerId: CENTER_B,
          displayName: "Center B",
          version: VERSION_B,
        },
      ],
      nextAfterId: null,
    });
    await controller.loadCenters();
    expect(controller.state.centerId).toBeNull();
    expect(controller.state.exportedPackage).toBeNull();
    expect(controller.state.memberships).toEqual([]);
  });

  it("resets every center-scoped presentation field before loading the next center", async () => {
    const { controller } = await openClass();
    const switching = controller.selectCenter(CENTER_B);
    expect(controller.state.centerId).toBe(CENTER_B);
    expect(controller.state.classes).toEqual([]);
    expect(controller.state.classesLoaded).toBe(false);
    expect(controller.state.accounts).toEqual([]);
    expect(controller.state.accountsLoaded).toBe(false);
    for (const field of [
      "accountId",
      "accountDraft",
      "accountRecovery",
      "accountCreateDraft",
      "accountCreateRecovery",
      "classId",
      "currentTeachingVersion",
      "classDraft",
      "classRecovery",
      "classCreateDraft",
      "classCreateRecovery",
      "importPackage",
      "importPreview",
      "importPreviewReviewedId",
      "exportedPackage",
      "lastRevocation",
      "pendingCenterId",
      "pendingClassId",
      "pendingAccountId",
    ] as const) {
      expect(controller.state[field]).toBeNull();
    }
    expect(controller.state.memberships).toEqual([]);
    expect(controller.state.membershipsLoaded).toBe(false);
    expect(controller.state.classRevisionLoaded).toBe(false);
    expect(controller.state.importPreviewExpired).toBe(false);
    await switching;
  });

  it("exercises unloaded, unavailable, and impossible action guards", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, () => undefined);
    controller.editClass("ignored");
    controller.editAccount("ignored");
    controller.setImportPackage(exchange);
    await controller.loadCenters();
    await controller.loadClasses();
    await controller.loadAccounts();
    await controller.loadMemberships();
    await controller.loadClassRevision();
    controller.acceptReadback();
    await controller.load();
    await controller.selectCenter(CENTER_A);
    controller.editClass("no selected class");
    controller.editAccount("no selected account");
    await controller.createAccount({
      userId: "user:foreign",
      displayName: "Foreign class",
      login: "foreign-class",
      role: "teacher",
      classId: CLASS_B,
    });
    await controller.changeMembership(USER_A, "revoked");
    await controller.selectClass(CLASS_B);
    controller.selectAccount(USER_B);
    expect(client.createAccount).not.toHaveBeenCalled();
    expect(client.changeMembership).not.toHaveBeenCalled();
  });

  it("stops load orchestration and selectors after access failure or disposal", async () => {
    const failed = controllerClient();
    failed.access.mockRejectedValueOnce(new Error("offline"));
    const failedController = new GovernanceController(failed, () => undefined);
    await failedController.load();
    expect(failedController.state.access).toBeNull();
    expect(failedController.state.problem).toBe("load");

    const client = controllerClient();
    const controller = new GovernanceController(client, () => undefined);
    await controller.load();
    controller.dispose();
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    controller.selectAccount(USER_A);
    controller.confirmAccountSwitch(false);
    await controller.loadCenters();
    expect(controller.state.centerId).toBeNull();
  });

  it("handles unknown read and mutation failures without weakening the fail-closed state", async () => {
    const { client, controller } = await openClass();
    client.classes.mockRejectedValueOnce(new Error("mystery read"));
    await controller.loadClasses();
    expect(controller.state.problem).toBe("load");

    client.classes.mockRejectedValueOnce({ code: "mystery read object" });
    await controller.loadClasses();
    expect(controller.state.problem).toBe("load");

    client.classes.mockRejectedValueOnce(
      Object.assign(new Error("invalid read"), { code: "invalid" }),
    );
    await controller.loadClasses();
    expect(controller.state.problem).toBe("invalid");

    controller.editClass("mystery mutation");
    client.renameClass.mockRejectedValueOnce({ code: "mystery mutation" });
    await controller.renameClass();
    expect(controller.state.problem).toBe("load");

    controller.editClass("forbidden mutation");
    client.renameClass.mockRejectedValueOnce(
      Object.assign(new Error("forbidden mutation"), { code: "forbidden" }),
    );
    await controller.renameClass();
    expect(controller.state.access).toBeNull();
  });

  it("ignores stale read and mutation failures after switching their center", async () => {
    const { client, controller } = await openClass();
    const classes = deferred<GovernanceClassesResponse>();
    client.classes.mockImplementationOnce(() => classes.promise);
    const loading = controller.loadClasses();
    await controller.selectCenter(CENTER_B);
    classes.reject(new Error("stale read"));
    await loading;
    expect(controller.state.centerId).toBe(CENTER_B);

    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    controller.editClass("stale mutation");
    const rename = deferred<GovernanceRenameClassResponse>();
    client.renameClass.mockImplementationOnce(() => rename.promise);
    const saving = controller.renameClass();
    expect(client.renameClass).toHaveBeenCalledTimes(1);
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    rename.reject(new Error("stale mutation"));
    await saving;
    expect(controller.state.centerId).toBe(CENTER_B);
    expect(controller.state.problem).toBeNull();
  });

  it("ignores overlapping creates without dropping the first operation", async () => {
    const { client, controller } = await openClass();
    const classCreate = deferred<Awaited<ReturnType<typeof client.createClass>>>();
    client.createClass.mockImplementationOnce(() => classCreate.promise);
    const creatingClass = controller.createClass("class:busy", "Busy class");
    await controller.createClass("class:ignored", "Ignored class");
    await controller.changeMembership(USER_A, "revoked");
    classCreate.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-created",
      classroom: classroom("class:busy", CENTER_A, "Busy class"),
    });
    await creatingClass;
    expect(client.createClass).toHaveBeenCalledTimes(1);

    const accountCreate = deferred<Awaited<ReturnType<typeof client.createAccount>>>();
    client.createAccount.mockImplementationOnce(() => accountCreate.promise);
    const creatingAccount = controller.createAccount({
      userId: "user:busy",
      displayName: "Busy account",
      login: "busy-account",
      role: "teacher",
      classId: null,
    });
    await controller.createAccount({
      userId: "user:ignored",
      displayName: "Ignored account",
      login: "ignored-account",
      role: "teacher",
      classId: null,
    });
    accountCreate.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-account-created",
      account: account("user:busy", CENTER_A, "Busy account"),
    });
    await creatingAccount;
    expect(client.createAccount).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired reviewed preview and safely cancels when no preview exists", async () => {
    const client = controllerClient();
    client.previewClassImport.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-import-previewed",
      preview: preview("2024-12-31T00:00:00Z"),
    });
    const controller = new GovernanceController(client, () => undefined);
    await controller.load();
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    await controller.confirmClassImport();
    expect(controller.state.importPreviewExpired).toBe(true);
    expect(client.confirmClassImport).not.toHaveBeenCalled();
    await controller.cancelClassImport();
    await controller.cancelClassImport();
    expect(controller.state.importPreview).toBeNull();
  });

  it("covers explicit same-selection and pending-switch decisions", async () => {
    const { client, controller } = await openClass();
    controller.editClass("Center dirty");
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(false);
    expect(controller.state.pendingCenterId).toBeNull();
    client.classes.mockResolvedValueOnce(
      classesResponse([classroom(CLASS_A, CENTER_A), classroom(CLASS_B, CENTER_A)]),
    );
    await controller.loadClasses();
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    controller.editClass("Dirty class");
    await controller.selectClass("class:b");
    expect(controller.state.pendingClassId).toBe("class:b");
    await controller.confirmClassSwitch(true);
    expect(controller.state.classId).toBe(CLASS_B);
    controller.selectAccount(USER_A);
    controller.editAccount("Dirty account");
    client.accounts.mockResolvedValueOnce(
      accountsResponse([account(USER_A, CENTER_A), account(USER_B, CENTER_A)]),
    );
    await controller.loadAccounts();
    controller.selectAccount(USER_B);
    expect(controller.state.pendingAccountId).toBe(USER_B);
    controller.confirmAccountSwitch(false);
    controller.selectAccount(USER_A);
    controller.selectAccount(USER_B);
    controller.confirmAccountSwitch(true);
    expect(controller.state.accountId).toBe(USER_B);
  });

  it("discards a failed old class open after navigating to a newer class", async () => {
    const { client, controller } = await openClass();
    client.classes.mockResolvedValueOnce(
      classesResponse([classroom(CLASS_A, CENTER_A), classroom(CLASS_B, CENTER_A)]),
    );
    await controller.loadClasses();
    let rejectMemberships!: (error: Error) => void;
    let resolveRevision!: (value: Awaited<ReturnType<typeof client.classRevision>>) => void;
    client.memberships.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectMemberships = reject)),
    );
    client.classRevision.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRevision = resolve)),
    );
    const opening = controller.selectClass(CLASS_B);
    await controller.selectClass(CLASS_A);
    rejectMemberships(new Error("stale class"));
    resolveRevision({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-revision-response",
      centerId: CENTER_A,
      classId: CLASS_A,
      teachingVersion: VERSION_A,
    });
    await opening;
    expect(controller.state.classId).toBe(CLASS_A);
    expect(controller.state.problem).toBeNull();
  });

  it("fails closed when scoped list refresh removes a selected class or account", async () => {
    const { client, controller } = await openClass();
    client.classes.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-classes-response",
      items: [],
      nextAfterId: null,
    });
    await controller.loadClasses();
    expect(controller.state.classId).toBeNull();
    controller.selectAccount(USER_A);
    client.accounts.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-accounts-response",
      items: [],
      nextAfterId: null,
    });
    await controller.loadAccounts();
    expect(controller.state.accountId).toBeNull();
  });

  it("handles an absent membership row and then adopts a newly added membership", async () => {
    const { client, controller } = await openClass();
    client.accounts.mockResolvedValueOnce(
      accountsResponse([account(USER_A, CENTER_A), account(USER_B, CENTER_A)]),
    );
    await controller.loadAccounts();
    await controller.changeMembership(USER_B, "revoked");
    expect(client.changeMembership).not.toHaveBeenCalled();
    client.changeMembership.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-membership-changed",
      membership: {
        userId: USER_B,
        classId: CLASS_A,
        centerId: CENTER_A,
        role: "teacher",
        state: "active",
        version: VERSION_B,
      },
    });
    await controller.changeMembership(USER_B, "active");
    expect(controller.state.memberships.some((row) => row.userId === USER_B)).toBe(true);
    client.changeMembership.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-membership-changed",
      membership: {
        userId: USER_B,
        classId: CLASS_A,
        centerId: CENTER_A,
        role: "teacher",
        state: "revoked",
        version: VERSION_A,
      },
    });
    await controller.changeMembership(USER_B, "revoked");
  });
});
