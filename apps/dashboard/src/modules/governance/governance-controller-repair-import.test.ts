import { RequestIdSchema } from "@marea/protocol";
import type {
  GovernanceRenameAccountResponse,
  GovernanceRenameClassResponse,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import {
  CLASS_A,
  accountsResponse,
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
  deferred,
  classesResponse,
  openClass,
} from "./governance-controller-test-support.fixture.js";

const REQUEST_ID = RequestIdSchema.parse("request:controller");

describe("governance administrator controller repair regressions", () => {
  it("hides a cached preview when reopening its class sees a newer revision", async () => {
    const { client, controller } = await openClass();
    controller.setImportPackage(exchange);
    await controller.previewClassImport();

    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    await controller.selectCenter(CENTER_A);
    client.classRevision.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-revision-response",
      centerId: CENTER_A,
      classId: CLASS_A,
      teachingVersion: VERSION_B,
    });
    await controller.selectClass(CLASS_A);

    expect(controller.state.currentTeachingVersion).toBe(VERSION_B);
    expect(controller.state.importPreview).toBeNull();
    expect(controller.state.importPreviewReviewedId).toBeNull();
    expect(controller.state.importPreviewExpired).toBe(false);
    expect(controller.state.importPackage).toEqual(exchange);
    await controller.cancelClassImport();
  });

  it("clears prior class and account presentation when create readbacks select new rows", async () => {
    const { client, controller } = await openClass();
    await controller.exportClass();
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    client.createClass.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-created",
      classroom: classroom(CLASS_B, CENTER_A, "Created class"),
    });
    await controller.createClass(CLASS_B, "Created class");
    expect(controller.state.classId).toBe(CLASS_B);
    expect(controller.state.memberships).toEqual([]);
    expect(controller.state.classRevisionLoaded).toBe(false);
    expect(controller.state.currentTeachingVersion).toBeNull();
    expect(controller.state.exportedPackage).toBeNull();
    expect(controller.state.importPackage).toBeNull();
    expect(controller.state.importPreview).toBeNull();

    await controller.loadAccounts();
    controller.selectAccount(USER_A);
    await controller.revokeSessions();
    expect(controller.state.lastRevocation).not.toBeNull();
    client.createAccount.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-account-created",
      account: account(USER_B, CENTER_A, "Created account"),
    });
    await controller.createAccount({
      userId: USER_B,
      displayName: "Created account",
      login: "created-account",
      role: "teacher",
      classId: null,
    });
    expect(controller.state.accountId).toBe(USER_B);
    expect(controller.state.accountDraft).toBeNull();
    expect(controller.state.accountRecovery).toBeNull();
    expect(controller.state.lastRevocation).toBeNull();
  });

  it("rebases a newer class and account draft after its own rename readback", async () => {
    const { client, controller } = await openClass();
    controller.editClass("First");
    const rename = deferred<GovernanceRenameClassResponse>();
    client.renameClass.mockImplementationOnce(() => rename.promise);
    const savingClass = controller.renameClass();
    controller.editClass("Second");
    rename.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-renamed",
      classroom: { ...classroom(CLASS_A, CENTER_A, "First"), version: VERSION_B },
    });
    await savingClass;
    expect(controller.state.classDraft).toMatchObject({
      displayName: "Second",
      expectedVersion: VERSION_B,
    });

    controller.selectAccount(USER_A);
    controller.editAccount("First account");
    const accountRename = deferred<GovernanceRenameAccountResponse>();
    client.renameAccount.mockImplementationOnce(() => accountRename.promise);
    const savingAccount = controller.renameAccount();
    controller.editAccount("Second account");
    accountRename.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-account-renamed",
      account: { ...account(USER_A, CENTER_A, "First account"), version: VERSION_B },
    });
    await savingAccount;
    expect(controller.state.accountDraft).toMatchObject({
      displayName: "Second account",
      expectedVersion: VERSION_B,
    });
  });

  it("rebases the submitted draft when readback acceptance cleared its cached draft", async () => {
    const { client, controller } = await openClass();
    controller.editClass("Class readback");
    const classRename = deferred<GovernanceRenameClassResponse>();
    client.renameClass.mockImplementationOnce(() => classRename.promise);
    const savingClass = controller.renameClass();
    client.classes.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-classes-response",
      items: [classroom(CLASS_A, CENTER_A)],
      nextAfterId: null,
    });
    await controller.loadClasses();
    controller.acceptReadback();
    classRename.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-renamed",
      classroom: { ...classroom(CLASS_A, CENTER_A, "Class readback"), version: VERSION_B },
    });
    await savingClass;
    expect(controller.state.classDraft).toMatchObject({
      displayName: "Class readback",
      expectedVersion: VERSION_B,
    });

    controller.selectAccount(USER_A);
    controller.editAccount("Account readback");
    const accountRename = deferred<GovernanceRenameAccountResponse>();
    client.renameAccount.mockImplementationOnce(() => accountRename.promise);
    const savingAccount = controller.renameAccount();
    client.accounts.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-accounts-response",
      items: [account(USER_A, CENTER_A)],
      nextAfterId: null,
    });
    await controller.loadAccounts();
    controller.acceptReadback();
    accountRename.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-account-renamed",
      account: { ...account(USER_A, CENTER_A, "Account readback"), version: VERSION_B },
    });
    await savingAccount;
    expect(controller.state.accountDraft).toMatchObject({
      displayName: "Account readback",
      expectedVersion: VERSION_B,
    });
  });

  it("restores deliberate create drafts after navigation and counts them as unsaved work", async () => {
    const { client, controller } = await openClass();
    client.createClass.mockRejectedValueOnce(
      Object.assign(new Error("unknown"), { code: "uncertain" }),
    );
    await controller.createClass("class:resume", "Resume class");
    expect(controller.state.classCreateDraft?.classId).toBe("class:resume");
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    await controller.selectCenter(CENTER_A);
    expect(controller.state.classCreateDraft).toBeNull();
    controller.resumeClassCreateDraft(CENTER_A, "class:resume");
    expect(controller.state.classCreateDraft?.displayName).toBe("Resume class");
    controller.resumeClassCreateDraft(CENTER_A, "class:missing");
    controller.dismissClassCreateDraft(CENTER_A, "class:resume");
    expect(controller.state.classCreateDraft).toBeNull();
    controller.dismissClassCreateDraft(CENTER_A, "class:missing");
  });

  it("restores account create drafts by stable center/user identity", async () => {
    const { client, controller } = await openClass();
    client.createAccount.mockRejectedValueOnce(
      Object.assign(new Error("uncertain"), { code: "uncertain" }),
    );
    await controller.createAccount({
      userId: "user:resume",
      displayName: "Resume account",
      login: "resume-account",
      role: "teacher",
      classId: null,
    });
    controller.selectAccount(USER_A);
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    await controller.selectCenter(CENTER_A);
    controller.resumeAccountCreateDraft(CENTER_A, "user:resume");
    expect(controller.state.accountCreateDraft?.displayName).toBe("Resume account");
    controller.dismissAccountCreateDraft(CENTER_A, "user:resume");
    expect(controller.state.accountCreateDraft).toBeNull();
    controller.resumeAccountCreateDraft(CENTER_B, "user:missing");
    controller.dismissAccountCreateDraft(CENTER_B, "user:missing");
  });

  it("fails closed when draft recovery rows are absent and reloads a center without a class", async () => {
    const { client, controller } = await openClass();
    controller.editClass("class recovery");
    client.classes.mockResolvedValueOnce(classesResponse([classroom(CLASS_B, CENTER_A)]));
    await controller.loadClasses();
    expect(controller.state.classRecovery).toBeNull();

    client.createClass.mockRejectedValueOnce(
      Object.assign(new Error("unknown class create"), { code: "uncertain" }),
    );
    await controller.createClass("class:missing-recovery", "Missing class recovery");
    client.classes.mockResolvedValueOnce(classesResponse([classroom(CLASS_B, CENTER_A)]));
    await controller.loadClasses();
    expect(controller.state.classCreateRecovery).toBeNull();

    await controller.loadAccounts();
    controller.selectAccount(USER_A);
    controller.editAccount("account recovery");
    controller.editAccount("");
    expect(controller.state.problem).toBe("invalid");
    client.accounts.mockResolvedValueOnce(accountsResponse([account(USER_B, CENTER_A)]));
    await controller.loadAccounts();
    expect(controller.state.accountRecovery).toBeNull();

    client.createAccount.mockRejectedValueOnce(
      Object.assign(new Error("unknown account create"), { code: "uncertain" }),
    );
    await controller.createAccount({
      userId: "user:missing-recovery",
      displayName: "Missing account recovery",
      login: "missing-account-recovery",
      role: "teacher",
      classId: null,
    });
    client.accounts.mockResolvedValueOnce(accountsResponse([account(USER_B, CENTER_A)]));
    await controller.loadAccounts();
    expect(controller.state.accountCreateRecovery).toBeNull();

    await controller.selectCenter(CENTER_B);
    await controller.reload();
    expect(controller.state.classId).toBeNull();
  });

  it("adopts create readbacks that replace existing class and account rows", async () => {
    const { client, controller } = await openClass();
    client.classes.mockResolvedValueOnce(
      classesResponse([
        classroom(CLASS_A, CENTER_A),
        classroom(CLASS_B, CENTER_A),
        classroom("class:existing", CENTER_A),
      ]),
    );
    await controller.loadClasses();
    client.createClass.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-created",
      classroom: classroom("class:existing", CENTER_A, "Created over class"),
    });
    await controller.createClass("class:existing", "Created over class");
    expect(
      controller.state.classes.find((row) => row.classId === "class:existing")?.displayName,
    ).toBe("Created over class");

    client.accounts.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-accounts-response",
      items: [
        account(USER_A, CENTER_A),
        account(USER_B, CENTER_A),
        account("user:existing", CENTER_A),
      ],
      nextAfterId: null,
    });
    await controller.loadAccounts();
    controller.selectAccount(USER_A);
    client.createAccount.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-account-created",
      account: account("user:existing", CENTER_A, "Created over account"),
    });
    await controller.createAccount({
      userId: "user:existing",
      displayName: "Created over account",
      login: "created-over-account",
      role: "teacher",
      classId: null,
    });
    expect(
      controller.state.accounts.find((row) => row.userId === "user:existing")?.displayName,
    ).toBe("Created over account");
  });

  it("discards a completed class open when both stale reads resolve", async () => {
    const { client, controller } = await openClass();
    client.classes.mockResolvedValueOnce(
      classesResponse([classroom(CLASS_A, CENTER_A), classroom(CLASS_B, CENTER_A)]),
    );
    await controller.loadClasses();
    const memberships = deferred<Awaited<ReturnType<typeof client.memberships>>>();
    const revision = deferred<Awaited<ReturnType<typeof client.classRevision>>>();
    client.memberships.mockImplementationOnce(() => memberships.promise);
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const opening = controller.selectClass(CLASS_B);
    await controller.selectClass(CLASS_A);
    memberships.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-memberships-response",
      items: [],
      nextAfterId: null,
    });
    revision.resolve({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-revision-response",
      centerId: CENTER_A,
      classId: CLASS_B,
      teachingVersion: VERSION_B,
    });
    await opening;
    expect(controller.state.classId).toBe(CLASS_A);
    expect(controller.state.membershipsLoaded).toBe(true);
  });

  it("rejects exchange responses bound to a different class or preview", async () => {
    const { client, controller } = await openClass();
    controller.setImportPackage(exchange);
    client.previewClassImport.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-import-previewed",
      preview: { ...preview(), centerId: CENTER_B },
    });
    await controller.previewClassImport();
    expect(controller.state.importPreview).toBeNull();
    expect(controller.state.problem).toBe("invalid");

    client.previewClassImport.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-import-previewed",
      preview: preview(),
    });
    await controller.previewClassImport();
    client.confirmClassImport.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-import-confirmed",
      classId: CLASS_B,
      teachingVersion: VERSION_B,
    });
    await controller.confirmClassImport();
    expect(controller.state.currentTeachingVersion).toBe(VERSION_A);
    expect(controller.state.importPreview).not.toBeNull();
    expect(controller.state.problem).toBe("invalid");

    client.cancelClassImport.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-import-cancelled",
      previewId: "preview:wrong",
    });
    await controller.cancelClassImport();
    expect(controller.state.importPreview).not.toBeNull();
    expect(controller.state.problem).toBe("invalid");
  });

  it("clears the active package while retaining only an explicitly cancellable stale preview", async () => {
    const { client, controller } = await openClass();
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    controller.setImportPackage(null);

    expect(controller.state.importPackage).toBeNull();
    expect(controller.state.importPreview).toBeNull();
    expect(controller.state.importPreviewReviewedId).toBeNull();
    await controller.previewClassImport();
    expect(client.previewClassImport).toHaveBeenCalledTimes(1);

    await controller.cancelClassImport();
    expect(client.cancelClassImport).toHaveBeenCalledWith(
      { centerId: CENTER_A, classId: CLASS_A, previewId: preview().previewId },
      expect.any(AbortSignal),
    );
    expect(controller.state.importPreview).toBeNull();
  });

  it("rejects preview responses with a mismatched class or expected version", async () => {
    for (const responsePreview of [
      { ...preview(), classId: CLASS_B },
      { ...preview(), expectedTeachingVersion: VERSION_B },
    ]) {
      const { client, controller } = await openClass();
      controller.setImportPackage(exchange);
      client.previewClassImport.mockResolvedValueOnce({
        protocolVersion: "0.1",
        requestId: REQUEST_ID,
        kind: "governance-class-import-previewed",
        preview: responsePreview,
      });
      await controller.previewClassImport();
      expect(controller.state.importPreview).toBeNull();
      expect(controller.state.problem).toBe("invalid");
    }
  });
});
