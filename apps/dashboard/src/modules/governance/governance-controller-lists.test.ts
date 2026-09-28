import { describe, expect, it } from "vitest";

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
  classesResponse,
  classroom,
  controllerClient,
  deferred,
  exchange,
  failure,
  membership,
  membershipsResponse,
  openTwoClassCenter,
  revisionResponse,
} from "./governance-controller-test-support.fixture.js";

type Client = ReturnType<typeof controllerClient>;
type Classes = Awaited<ReturnType<Client["classes"]>>;
type Accounts = Awaited<ReturnType<Client["accounts"]>>;
type Memberships = Awaited<ReturnType<Client["memberships"]>>;
type Revision = Awaited<ReturnType<Client["classRevision"]>>;

describe("governance controller scoped lists", () => {
  it("reads classes page by page and adopts only the latest read for the selected class", async () => {
    const { client, controller } = await openTwoClassCenter();
    expect(client.classes).toHaveBeenCalledWith(
      { centerId: CENTER_A, afterId: null },
      expect.any(AbortSignal),
    );
    client.classes
      .mockResolvedValueOnce({ ...classesResponse([classroom(CLASS_A)]), nextAfterId: CLASS_A })
      .mockResolvedValueOnce(classesResponse([classroom(CLASS_B)]));
    await controller.loadClasses();
    expect(controller.state.classes.map((row) => row.classId)).toEqual([CLASS_A, CLASS_B]);

    const older = deferred<Classes>();
    client.classes.mockImplementationOnce(() => older.promise);
    const olderLoad = controller.loadClasses();
    await controller.loadClasses();
    older.resolve(classesResponse([classroom(CLASS_A)]));
    await olderLoad;
    expect(controller.state.classes).toHaveLength(2);

    const beforeSelection = deferred<Classes>();
    client.classes.mockImplementationOnce(() => beforeSelection.promise);
    const selectionLoad = controller.loadClasses();
    await controller.selectClass(CLASS_B);
    beforeSelection.resolve(classesResponse([classroom(CLASS_A)]));
    await selectionLoad;
    expect(controller.state.classId).toBe(CLASS_B);
    expect(controller.state.classes).toHaveLength(2);

    client.classes.mockResolvedValueOnce(classesResponse([classroom(CLASS_A, CENTER_B)]));
    await controller.loadClasses();
    expect(controller.state.problem).toBe("invalid");
    expect(controller.state.classes).toHaveLength(2);
  });

  it("clears a removed selected class, invalidating its reads and pending switch", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.editClass("Unsaved");
    await controller.selectClass(CLASS_B);
    expect(controller.state.pendingClassId).toBe(CLASS_B);

    client.classes.mockResolvedValueOnce(classesResponse([classroom(CLASS_A)]));
    await controller.loadClasses();
    expect(controller.state.pendingClassId).toBeNull();
    await controller.selectClass(CLASS_B);
    expect(controller.state.pendingClassId).toBeNull();

    await controller.loadClasses();
    await controller.selectClass(CLASS_B);
    expect(controller.state.pendingClassId).toBe(CLASS_B);
    const memberships = deferred<Memberships>();
    client.memberships.mockImplementationOnce(() => memberships.promise);
    const membershipLoad = controller.loadMemberships();
    client.classes.mockResolvedValueOnce(classesResponse([classroom(CLASS_B)]));
    await controller.loadClasses();
    expect(controller.state.classId).toBeNull();
    expect(controller.state.classDraft).toBeNull();
    expect(controller.state.pendingClassId).toBeNull();
    expect(controller.state.membershipsLoaded).toBe(false);
    memberships.resolve(membershipsResponse([]));
    await membershipLoad;
    expect(controller.state.membershipsLoaded).toBe(false);
  });

  it("presents class and create readbacks only for rows that exist", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.editClass("Draft");
    client.createClass.mockRejectedValueOnce(failure("uncertain"));
    await controller.createClass(CLASS_B, "Created");
    await controller.loadClasses();
    expect(controller.state.classRecovery).toEqual(classroom(CLASS_A));
    expect(controller.state.classCreateRecovery).toEqual(classroom(CLASS_B));

    client.classes.mockResolvedValueOnce(
      classesResponse([classroom(CLASS_A, CENTER_A, "Renamed"), classroom("class:c")]),
    );
    await controller.loadClasses();
    expect(controller.state.classRecovery?.displayName).toBe("Renamed");
    expect(controller.state.classCreateRecovery).toBeNull();
  });

  it("reads accounts page by page and adopts only the latest read for the selected account", async () => {
    const { client, controller } = await openTwoClassCenter();
    expect(client.accounts).toHaveBeenCalledWith(
      { centerId: CENTER_A, afterId: null },
      expect.any(AbortSignal),
    );
    client.accounts
      .mockResolvedValueOnce({ ...accountsResponse([account(USER_A)]), nextAfterId: USER_A })
      .mockResolvedValueOnce(accountsResponse([account(USER_B)]));
    await controller.loadAccounts();
    expect(controller.state.accounts.map((row) => row.userId)).toEqual([USER_A, USER_B]);

    const older = deferred<Accounts>();
    client.accounts.mockImplementationOnce(() => older.promise);
    const olderLoad = controller.loadAccounts();
    await controller.loadAccounts();
    older.resolve(accountsResponse([account(USER_A)]));
    await olderLoad;
    expect(controller.state.accounts).toHaveLength(2);

    const beforeSelection = deferred<Accounts>();
    client.accounts.mockImplementationOnce(() => beforeSelection.promise);
    const selectionLoad = controller.loadAccounts();
    controller.selectAccount(USER_B);
    beforeSelection.resolve(accountsResponse([account(USER_A)]));
    await selectionLoad;
    expect(controller.state.accountId).toBe(USER_B);
    expect(controller.state.accounts).toHaveLength(2);

    client.accounts.mockResolvedValueOnce(accountsResponse([account(USER_A, CENTER_B)]));
    await controller.loadAccounts();
    expect(controller.state.problem).toBe("invalid");
    expect(controller.state.accounts).toHaveLength(2);
  });

  it("keeps an account list read alive while a class opens without an account selection", async () => {
    const { client, controller } = await openTwoClassCenter();
    const accounts = deferred<Accounts>();
    client.accounts.mockImplementationOnce(() => accounts.promise);
    const loading = controller.loadAccounts();
    await controller.selectClass(CLASS_A);
    accounts.resolve(accountsResponse([account(USER_B)]));
    await loading;
    expect(controller.state.accounts.map((row) => row.userId)).toEqual([USER_B]);
  });

  it("clears a removed selected account, invalidating its writes and pending switch", async () => {
    const { client, controller } = await openTwoClassCenter();
    controller.selectAccount(USER_A);
    controller.editAccount("Unsaved");
    controller.selectAccount(USER_B);
    expect(controller.state.pendingAccountId).toBe(USER_B);
    client.accounts.mockResolvedValueOnce(accountsResponse([account(USER_A)]));
    await controller.loadAccounts();
    expect(controller.state.pendingAccountId).toBeNull();

    await controller.loadAccounts();
    controller.selectAccount(USER_B);
    expect(controller.state.pendingAccountId).toBe(USER_B);
    const rename = deferred<Awaited<ReturnType<Client["renameAccount"]>>>();
    client.renameAccount.mockImplementationOnce(() => rename.promise);
    const renaming = controller.renameAccount();
    client.accounts.mockResolvedValueOnce(accountsResponse([account(USER_B)]));
    await controller.loadAccounts();
    expect(controller.state.accountId).toBeNull();
    expect(controller.state.accountDraft).toBeNull();
    expect(controller.state.pendingAccountId).toBeNull();
    rename.resolve(
      await controllerClient().renameAccount(
        { centerId: CENTER_A, userId: USER_A, displayName: "Renamed", expectedVersion: VERSION_A },
        new AbortController().signal,
      ),
    );
    await renaming;
    expect(controller.state.accountId).toBeNull();
  });

  it("presents account and create readbacks only for rows that exist", async () => {
    const { client, controller } = await openTwoClassCenter();
    controller.selectAccount(USER_A);
    controller.editAccount("Draft");
    client.createAccount.mockRejectedValueOnce(failure("uncertain"));
    await controller.createAccount({
      userId: USER_B,
      displayName: "Created",
      login: "created-user",
      role: "student",
      classId: null,
    });
    await controller.loadAccounts();
    expect(controller.state.accountRecovery).toEqual(account(USER_A));
    expect(controller.state.accountCreateRecovery).toEqual(account(USER_B));

    client.accounts.mockResolvedValueOnce(
      accountsResponse([account(USER_A, CENTER_A, "Renamed"), account("user:c")]),
    );
    await controller.loadAccounts();
    expect(controller.state.accountRecovery?.displayName).toBe("Renamed");
    expect(controller.state.accountCreateRecovery).toBeNull();
  });

  it("reads class memberships for the selected class only", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.loadMemberships();
    expect(client.memberships).not.toHaveBeenCalled();
    await controller.selectClass(CLASS_A);
    client.memberships
      .mockResolvedValueOnce(membershipsResponse([membership(USER_A)], USER_A))
      .mockResolvedValueOnce(membershipsResponse([membership(USER_B)]));
    await controller.loadMemberships();
    expect(client.memberships).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, classId: CLASS_A, afterId: USER_A },
      expect.any(AbortSignal),
    );
    expect(controller.state.memberships.map((row) => row.userId)).toEqual([USER_A, USER_B]);

    const older = deferred<Memberships>();
    client.memberships.mockImplementationOnce(() => older.promise);
    const olderLoad = controller.loadMemberships();
    client.memberships.mockResolvedValueOnce(membershipsResponse([]));
    await controller.loadMemberships();
    older.resolve(membershipsResponse([membership(USER_A)]));
    await olderLoad;
    expect(controller.state.memberships).toEqual([]);

    const switched = deferred<Memberships>();
    client.memberships.mockImplementationOnce(() => switched.promise);
    const switchedLoad = controller.loadMemberships();
    await controller.selectClass(CLASS_B);
    switched.resolve(membershipsResponse([membership(USER_B)]));
    await switchedLoad;
    expect(controller.state.memberships.map((row) => row.classId)).toEqual([CLASS_B]);

    client.memberships.mockResolvedValueOnce(membershipsResponse([membership(USER_A)]));
    await controller.loadMemberships();
    expect(controller.state.problem).toBe("invalid");
    expect(controller.state.memberships.map((row) => row.classId)).toEqual([CLASS_B]);
  });

  it("reloads lists and then the selected class scope", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    for (const operation of Object.values(client)) operation.mockClear();
    await controller.reload();
    expect(client.classes).toHaveBeenCalledTimes(1);
    expect(client.accounts).toHaveBeenCalledTimes(1);
    expect(client.memberships).toHaveBeenCalledTimes(1);
    expect(client.classRevision).toHaveBeenCalledTimes(1);
  });
});

describe("governance controller class and account selection", () => {
  it("resets class presentation immediately and adopts both class reads together", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.selectAccount(USER_A);
    await controller.exportClass();
    await controller.revokeSessions();
    const memberships = deferred<Memberships>();
    const revision = deferred<Revision>();
    client.memberships.mockImplementationOnce(() => memberships.promise);
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const opening = controller.selectClass(CLASS_B);
    expect(controller.state).toMatchObject({
      classId: CLASS_B,
      accountId: null,
      memberships: [],
      membershipsLoaded: false,
      classRevisionLoaded: false,
      currentTeachingVersion: null,
      exportedPackage: null,
      lastRevocation: null,
      importPackage: null,
      importPreview: null,
      classDraft: null,
      classCreateDraft: null,
    });
    expect(client.memberships).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, classId: CLASS_B, afterId: null },
      expect.any(AbortSignal),
    );
    expect(client.classRevision).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, classId: CLASS_B },
      expect.any(AbortSignal),
    );
    memberships.resolve(membershipsResponse([membership(USER_A, "active", CLASS_B)]));
    await Promise.resolve();
    expect(controller.state.membershipsLoaded).toBe(false);
    revision.resolve(revisionResponse(VERSION_B, CLASS_B));
    await opening;
    expect(controller.state).toMatchObject({
      membershipsLoaded: true,
      classRevisionLoaded: true,
      currentTeachingVersion: VERSION_B,
      problem: null,
    });
    expect(controller.state.memberships).toHaveLength(1);
  });

  it("rejects mismatched class reads and discards reads for a replaced class", async () => {
    const { client, controller } = await openTwoClassCenter();
    client.classRevision.mockResolvedValueOnce(revisionResponse(VERSION_A, CLASS_A));
    await controller.selectClass(CLASS_B);
    expect(controller.state.problem).toBe("invalid");
    expect(controller.state.classRevisionLoaded).toBe(false);

    await controller.selectClass(CLASS_A);
    client.memberships.mockResolvedValueOnce(membershipsResponse([membership(USER_A)]));
    await controller.selectClass(CLASS_B);
    expect(controller.state.problem).toBe("invalid");
    expect(controller.state.membershipsLoaded).toBe(false);

    const revision = deferred<Revision>();
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const opening = controller.selectClass(CLASS_A);
    await controller.selectClass(CLASS_B);
    revision.resolve(revisionResponse(VERSION_B, CLASS_A));
    await opening;
    expect(controller.state.classId).toBe(CLASS_B);
    expect(controller.state.currentTeachingVersion).toBe(VERSION_A);

    const failing = deferred<Revision>();
    client.classRevision.mockImplementationOnce(() => failing.promise);
    const failedOpen = controller.selectClass(CLASS_A);
    await controller.selectClass(CLASS_B);
    failing.reject(failure("conflict"));
    await failedOpen;
    expect(controller.state.problem).toBeNull();

    client.classRevision.mockRejectedValueOnce(failure("conflict"));
    await controller.selectClass(CLASS_A);
    expect(controller.state.problem).toBe("conflict");
  });

  it("ignores unknown or current class and account selections and confirms pending switches", async () => {
    const { changed, client, controller } = await openTwoClassCenter();
    await controller.selectClass("class:unknown");
    expect(controller.state.classId).toBeNull();
    await controller.selectClass(CLASS_A);
    client.memberships.mockClear();
    await controller.selectClass(CLASS_A);
    expect(client.memberships).not.toHaveBeenCalled();

    controller.editClass("Unsaved");
    await controller.selectClass("class:unknown");
    expect(controller.state.pendingClassId).toBeNull();
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(false);
    expect(controller.state).toMatchObject({ classId: CLASS_A, pendingClassId: null });
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    expect(controller.state).toMatchObject({ classId: CLASS_B, pendingClassId: null });

    controller.selectAccount("user:unknown");
    expect(controller.state.accountId).toBeNull();
    controller.selectAccount(USER_A);
    changed.mockClear();
    controller.selectAccount(USER_A);
    expect(changed).not.toHaveBeenCalled();
    controller.editAccount("Unsaved");
    controller.selectAccount("user:unknown");
    expect(controller.state.pendingAccountId).toBeNull();
    controller.selectAccount(USER_B);
    controller.confirmAccountSwitch(false);
    expect(controller.state).toMatchObject({ accountId: USER_A, pendingAccountId: null });
    controller.selectAccount(USER_B);
    controller.confirmAccountSwitch(true);
    expect(controller.state).toMatchObject({ accountId: USER_B, pendingAccountId: null });
    changed.mockClear();
    controller.confirmAccountSwitch(true);
    expect(changed).not.toHaveBeenCalled();

    controller.selectAccount(USER_A);
    expect(controller.state).toMatchObject({
      accountId: USER_A,
      accountDraft: { displayName: "Unsaved" },
    });
  });

  it("restores class-scoped drafts, packages and cached previews when reopening a class", async () => {
    let now = 0;
    const { client, controller } = await openTwoClassCenter(() => now);
    await controller.selectClass(CLASS_A);
    client.createClass.mockRejectedValueOnce(failure("uncertain"));
    await controller.createClass(CLASS_A, "Create draft");
    controller.editClass("Edit draft");
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    const cached = controller.state.importPreview;
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);

    now = Date.parse("2099-01-01T00:00:00.000Z");
    const revision = deferred<Revision>();
    client.classRevision.mockImplementationOnce(() => revision.promise);
    await controller.selectClass(CLASS_A);
    const opening = controller.confirmClassSwitch(true);
    expect(controller.state).toMatchObject({
      classDraft: { displayName: "Edit draft" },
      classCreateDraft: { displayName: "Create draft" },
      importPreview: cached,
      importPreviewReviewedId: null,
      importPreviewExpired: true,
    });
    expect(controller.state.importPackage).not.toBeNull();
    revision.resolve(revisionResponse(VERSION_A));
    await opening;
    expect(controller.state.importPreview).toEqual(cached);
    expect(controller.state.importPreviewExpired).toBe(true);

    now = 0;
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    await controller.selectClass(CLASS_A);
    const reopening = controller.confirmClassSwitch(true);
    expect(controller.state.importPreviewExpired).toBe(false);
    await reopening;
    expect(controller.state.importPreviewExpired).toBe(false);

    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    client.classRevision.mockResolvedValueOnce(revisionResponse(VERSION_B));
    await controller.selectClass(CLASS_A);
    await controller.confirmClassSwitch(true);
    expect(controller.state.importPreview).toBeNull();
    client.cancelClassImport.mockClear();
    await controller.cancelClassImport();
    expect(client.cancelClassImport).toHaveBeenCalledTimes(1);
  });
});
