import { describe, expect, it, vi } from "vitest";

import { GovernanceController } from "./governance-controller.js";
import {
  CENTER_A,
  CENTER_B,
  CLASS_A,
  CLASS_B,
  USER_A,
  USER_B,
  VERSION_A,
  VERSION_B,
  account,
  accountsResponse,
  controllerClient,
  deferred,
  exchange,
  membership,
  membershipsResponse,
  openTwoClassCenter,
  revisionResponse,
} from "./governance-controller-test-support.fixture.js";

type Client = ReturnType<typeof controllerClient>;
const envelope = { protocolVersion: "0.1", requestId: "request:controller" } as const;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function reopenClassA(controller: GovernanceController): Promise<void> {
  await controller.selectClass(CLASS_B);
  await controller.confirmClassSwitch(true);
  await controller.selectClass(CLASS_A);
  await controller.confirmClassSwitch(true);
}

describe("governance controller scoped races", () => {
  it("adopts only the latest matching direct revision read", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.loadClassRevision();
    expect(client.classRevision).not.toHaveBeenCalled();
    await controller.selectClass(CLASS_A);
    const older = deferred<Awaited<ReturnType<Client["classRevision"]>>>();
    client.classRevision.mockImplementationOnce(() => older.promise);
    const olderRead = controller.loadClassRevision();
    expect(client.classRevision).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, classId: CLASS_A },
      expect.any(AbortSignal),
    );
    client.classRevision.mockResolvedValueOnce(revisionResponse(VERSION_B));
    await controller.loadClassRevision();
    older.resolve(revisionResponse(VERSION_A));
    await olderRead;
    expect(controller.state.currentTeachingVersion).toBe(VERSION_B);

    const switched = deferred<Awaited<ReturnType<Client["classRevision"]>>>();
    client.classRevision.mockImplementationOnce(() => switched.promise);
    const switchedRead = controller.loadClassRevision();
    await controller.selectClass(CLASS_B);
    switched.resolve(revisionResponse("version:c"));
    await switchedRead;
    expect(controller.state.currentTeachingVersion).toBe(VERSION_A);

    client.classRevision.mockResolvedValueOnce(revisionResponse(VERSION_B, CLASS_A));
    await controller.loadClassRevision();
    expect(controller.state).toMatchObject({ problem: "invalid", classRevisionLoaded: false });
  });

  it("hides and stashes a preview while its class revision reloads", async () => {
    let now = 0;
    const { client, controller } = await openTwoClassCenter(() => now);
    await controller.selectClass(CLASS_A);
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    now = Date.parse("2099-01-01T00:00:00.000Z");
    await controller.confirmClassImport();
    expect(controller.state.importPreviewExpired).toBe(true);
    const revision = deferred<Awaited<ReturnType<Client["classRevision"]>>>();
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const reading = controller.loadClassRevision();
    expect(controller.state).toMatchObject({
      classRevisionLoaded: false,
      currentTeachingVersion: null,
      importPreview: null,
      importPreviewReviewedId: null,
      importPreviewExpired: false,
    });
    revision.resolve(revisionResponse(VERSION_A));
    await reading;
    await reopenClassA(controller);
    expect(controller.state.importPreview).toBeNull();
  });

  it("keeps a cached matching preview through repeated class opens and hides a mismatched one", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    for (let round = 0; round < 2; round += 1) {
      await reopenClassA(controller);
      expect(controller.state.importPreview?.previewId).toBe("preview:a");
    }
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    client.classRevision.mockResolvedValueOnce(revisionResponse(VERSION_B));
    await controller.selectClass(CLASS_A);
    await controller.confirmClassSwitch(true);
    expect(controller.state.importPreview).toBeNull();
    await reopenClassA(controller);
    expect(controller.state.importPreview).toBeNull();
  });

  it("discards a class open whose memberships finished before the class changed", async () => {
    const { client, controller } = await openTwoClassCenter();
    const revision = deferred<Awaited<ReturnType<Client["classRevision"]>>>();
    client.memberships
      .mockResolvedValueOnce(membershipsResponse([membership(USER_A)], USER_A))
      .mockResolvedValueOnce(membershipsResponse([membership(USER_B)]));
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const opening = controller.selectClass(CLASS_A);
    await flush();
    expect(client.memberships).toHaveBeenCalledTimes(2);
    await controller.selectClass(CLASS_B);
    revision.resolve(revisionResponse(VERSION_B));
    await opening;
    expect(controller.state).toMatchObject({ classId: CLASS_B, currentTeachingVersion: VERSION_A });
    expect(controller.state.memberships.map((row) => row.classId)).toEqual([CLASS_B]);

    client.memberships
      .mockResolvedValueOnce(membershipsResponse([membership(USER_A)], USER_A))
      .mockResolvedValueOnce(membershipsResponse([membership(USER_B)]));
    await controller.selectClass(CLASS_A);
    expect(controller.state.memberships.map((row) => row.userId)).toEqual([USER_A, USER_B]);
  });

  it("invalidates in-flight class reads when a create readback selects another class", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    const memberships = deferred<Awaited<ReturnType<Client["memberships"]>>>();
    client.memberships.mockImplementationOnce(() => memberships.promise);
    const loading = controller.loadMemberships();
    client.createClass.mockResolvedValueOnce({
      ...envelope,
      kind: "governance-class-created",
      classroom: {
        classId: CLASS_B,
        centerId: CENTER_A,
        displayName: "B",
        version: VERSION_A,
        operatorReady: true,
      },
    });
    await controller.createClass(CLASS_B, "B");
    memberships.resolve(membershipsResponse([membership(USER_A)]));
    await loading;
    expect(controller.state).toMatchObject({ classId: CLASS_B, membershipsLoaded: false });
  });

  it("keeps class state after renaming the selected class", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.editClass("Renamed");
    client.renameClass.mockResolvedValueOnce({
      ...envelope,
      kind: "governance-class-renamed",
      classroom: {
        classId: CLASS_A,
        centerId: CENTER_A,
        displayName: "Renamed",
        version: VERSION_B,
        operatorReady: true,
      },
    });
    await controller.renameClass();
    expect(controller.state).toMatchObject({
      classId: CLASS_A,
      membershipsLoaded: true,
      classRevisionLoaded: true,
    });
  });

  it("keeps the selected account and its revocation after an account state change", async () => {
    const { client, controller } = await openTwoClassCenter();
    controller.selectAccount(USER_A);
    await controller.revokeSessions();
    await controller.changeAccountState("disabled");
    expect(controller.state.lastRevocation?.userId).toBe(USER_A);

    const accounts = deferred<Awaited<ReturnType<Client["accounts"]>>>();
    client.accounts.mockImplementationOnce(() => accounts.promise);
    const loading = controller.loadAccounts();
    client.createAccount.mockResolvedValueOnce({
      ...envelope,
      kind: "governance-account-created",
      account: account("user:c"),
    });
    await controller.createAccount({
      userId: "user:c",
      displayName: "Created",
      login: "created-user",
      role: "student",
      classId: null,
    });
    accounts.resolve(accountsResponse([account(USER_A)]));
    await loading;
    expect(controller.state.accountId).toBe("user:c");
  });

  it("discards account writes after a center or class change deselects the account", async () => {
    const { client, controller } = await openTwoClassCenter();
    controller.selectAccount(USER_A);
    const changing = deferred<Awaited<ReturnType<Client["changeAccountState"]>>>();
    client.changeAccountState.mockImplementationOnce(() => changing.promise);
    const pending = controller.changeAccountState("disabled");
    await controller.selectCenter(CENTER_B);
    changing.resolve({
      ...envelope,
      kind: "governance-account-state-changed",
      account: { ...account(USER_A), state: "disabled" },
    });
    await pending;
    expect(controller.state.accounts.some((row) => row.state === "disabled")).toBe(false);

    await controller.selectCenter(CENTER_A);
    controller.selectAccount(USER_A);
    const revoking = deferred<Awaited<ReturnType<Client["revokeSessions"]>>>();
    client.revokeSessions.mockImplementationOnce(() => revoking.promise);
    const revocation = controller.revokeSessions();
    await controller.selectClass(CLASS_A);
    revoking.resolve({
      ...envelope,
      kind: "governance-sessions-revoked",
      revocation: { userId: USER_A, version: VERSION_B, revokedAt: "2099-01-01T00:00:00Z" },
    });
    await revocation;
    expect(controller.state.lastRevocation).toBeNull();
  });

  it("uses the system clock by default for preview expiry", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    await controller.load();
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    await controller.confirmClassImport();
    expect(controller.state.currentTeachingVersion).toBe(VERSION_B);
  });

  it("keeps a later package staged after confirming the earlier one", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    const confirming = deferred<Awaited<ReturnType<Client["confirmClassImport"]>>>();
    client.confirmClassImport.mockImplementationOnce(() => confirming.promise);
    const pending = controller.confirmClassImport();
    const packageB = { ...exchange, source: { displayName: "Package B" } };
    controller.setImportPackage(packageB);
    confirming.resolve({
      ...envelope,
      kind: "governance-class-import-confirmed",
      classId: CLASS_A,
      teachingVersion: VERSION_B,
    });
    await pending;
    await controller.previewClassImport();
    expect(client.previewClassImport).toHaveBeenLastCalledWith(
      expect.objectContaining({ package: packageB, expectedTeachingVersion: VERSION_B }),
      expect.any(AbortSignal),
    );
  });

  it("clears create drafts when a create readback targets the selected row", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    client.createClass.mockResolvedValueOnce({
      ...envelope,
      kind: "governance-class-created",
      classroom: {
        classId: CLASS_A,
        centerId: CENTER_A,
        displayName: "A",
        version: VERSION_A,
        operatorReady: true,
      },
    });
    await controller.createClass(CLASS_A, "A");
    expect(controller.state.classCreateDraft).toBeNull();

    controller.selectAccount(USER_A);
    client.createAccount.mockResolvedValueOnce({
      ...envelope,
      kind: "governance-account-created",
      account: account(USER_A),
    });
    await controller.createAccount({
      userId: USER_A,
      displayName: "Teacher",
      login: "teacher-user",
      role: "teacher",
      classId: null,
    });
    expect(controller.state.accountCreateDraft).toBeNull();
  });

  it("keeps same-selection reads alive across class and account write readbacks", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.selectAccount(USER_A);
    controller.editClass("Renamed");
    const memberships = deferred<Awaited<ReturnType<Client["memberships"]>>>();
    client.memberships.mockImplementationOnce(() => memberships.promise);
    const loadingMemberships = controller.loadMemberships();
    await controller.renameClass();
    memberships.resolve(membershipsResponse([membership(USER_B)]));
    await loadingMemberships;
    expect(controller.state.memberships.map((row) => row.userId)).toEqual([USER_B]);

    const accounts = deferred<Awaited<ReturnType<Client["accounts"]>>>();
    client.accounts.mockImplementationOnce(() => accounts.promise);
    const loadingAccounts = controller.loadAccounts();
    await controller.changeAccountState("disabled");
    accounts.resolve(accountsResponse([account(USER_A, CENTER_A, "Listed")]));
    await loadingAccounts;
    expect(controller.state.accounts.map((row) => row.displayName)).toEqual(["Listed"]);
  });
});
