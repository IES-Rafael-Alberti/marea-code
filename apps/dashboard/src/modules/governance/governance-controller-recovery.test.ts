import { describe, expect, it } from "vitest";

import {
  CENTER_A,
  CENTER_B,
  CLASS_A,
  CLASS_B,
  USER_A,
  USER_B,
  accountsResponse,
  account,
  classesResponse,
  classroom,
  failure,
  openTwoClassCenter,
} from "./governance-controller-test-support.fixture.js";

const accountInput = {
  userId: "user:c",
  displayName: "Created",
  login: "created-user",
  role: "student" as const,
  classId: null,
};

describe("governance controller create-draft recovery", () => {
  it("resumes and dismisses class create drafts only in their own center", async () => {
    const { changed, client, controller } = await openTwoClassCenter();
    client.createClass.mockRejectedValueOnce(failure("uncertain"));
    await controller.createClass("class:c", "Created");
    expect(controller.state).toMatchObject({
      classCreateDraft: { classId: "class:c" },
      problem: "uncertain",
    });

    await controller.selectClass(CLASS_A);
    expect(controller.state.pendingClassId).toBe(CLASS_A);
    await controller.confirmClassSwitch(true);
    expect(controller.state.classCreateDraft).toBeNull();
    controller.resumeClassCreateDraft(CENTER_A, "class:c");
    expect(controller.state).toMatchObject({
      classCreateDraft: { classId: "class:c" },
      classCreateRecovery: null,
      problem: null,
    });

    client.classes.mockResolvedValueOnce(
      classesResponse([classroom(CLASS_A), classroom(CLASS_B), classroom("class:c")]),
    );
    await controller.loadClasses();
    controller.resumeClassCreateDraft(CENTER_A, "class:c");
    expect(controller.state.classCreateRecovery).toEqual(classroom("class:c"));

    changed.mockClear();
    controller.resumeClassCreateDraft(CENTER_A, "class:missing");
    controller.resumeClassCreateDraft(CENTER_B, "class:c");
    expect(changed).not.toHaveBeenCalled();

    controller.dismissClassCreateDraft(CENTER_A, "class:other");
    controller.dismissClassCreateDraft(CENTER_B, "class:c");
    expect(controller.state.classCreateDraft).not.toBeNull();
    controller.dismissClassCreateDraft(CENTER_A, "class:c");
    expect(controller.state).toMatchObject({ classCreateDraft: null, classCreateRecovery: null });
    changed.mockClear();
    controller.resumeClassCreateDraft(CENTER_A, "class:c");
    expect(changed).not.toHaveBeenCalled();
    await controller.selectClass(CLASS_B);
    expect(controller.state.classId).toBe(CLASS_B);
  });

  it("does not resume a draft from another selected center", async () => {
    const { client, controller } = await openTwoClassCenter();
    client.createClass.mockRejectedValueOnce(failure("uncertain"));
    await controller.createClass("class:c", "Created");
    client.createAccount.mockRejectedValueOnce(failure("uncertain"));
    await controller.createAccount(accountInput);
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    controller.resumeClassCreateDraft(CENTER_A, "class:c");
    controller.resumeAccountCreateDraft(CENTER_A, "user:c");
    expect(controller.state.classCreateDraft).toBeNull();
    expect(controller.state.accountCreateDraft).toBeNull();
    await controller.selectCenter(CENTER_A);
    expect(controller.state.centerId).toBe(CENTER_A);
  });

  it("resumes, restores and dismisses account create drafts", async () => {
    const { changed, client, controller } = await openTwoClassCenter();
    client.createAccount.mockRejectedValueOnce(failure("uncertain"));
    await controller.createAccount(accountInput);
    controller.selectAccount(USER_A);
    expect(controller.state.pendingAccountId).toBe(USER_A);
    controller.confirmAccountSwitch(true);
    expect(controller.state.accountCreateDraft).toBeNull();
    controller.resumeAccountCreateDraft(CENTER_A, "user:c");
    expect(controller.state).toMatchObject({
      accountCreateDraft: { userId: "user:c" },
      accountCreateRecovery: null,
      problem: null,
    });

    client.accounts.mockResolvedValueOnce(
      accountsResponse([account(USER_A), account(USER_B), account("user:c")]),
    );
    await controller.loadAccounts();
    controller.resumeAccountCreateDraft(CENTER_A, "user:c");
    expect(controller.state.accountCreateRecovery).toEqual(account("user:c"));
    controller.selectAccount("user:c");
    controller.confirmAccountSwitch(true);
    expect(controller.state).toMatchObject({
      accountId: "user:c",
      accountCreateDraft: { userId: "user:c" },
    });

    changed.mockClear();
    controller.resumeAccountCreateDraft(CENTER_A, "user:missing");
    expect(changed).not.toHaveBeenCalled();
    controller.dismissAccountCreateDraft(CENTER_A, "user:other");
    controller.dismissAccountCreateDraft(CENTER_B, "user:c");
    expect(controller.state.accountCreateDraft).not.toBeNull();
    controller.dismissAccountCreateDraft(CENTER_A, "user:c");
    expect(controller.state).toMatchObject({
      accountCreateDraft: null,
      accountCreateRecovery: null,
    });
    changed.mockClear();
    controller.resumeAccountCreateDraft(CENTER_A, "user:c");
    expect(changed).not.toHaveBeenCalled();
    controller.selectAccount(USER_B);
    expect(controller.state.accountId).toBe(USER_B);
  });

  it("accepts presented readbacks by discarding the drafts they replace", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.selectAccount(USER_A);
    controller.editClass("Class draft");
    controller.editAccount("Account draft");
    client.createClass.mockRejectedValueOnce(failure("uncertain"));
    await controller.createClass("class:c", "Created");
    client.createAccount.mockRejectedValueOnce(failure("uncertain"));
    await controller.createAccount(accountInput);
    client.classes.mockResolvedValueOnce(
      classesResponse([classroom(CLASS_A), classroom(CLASS_B), classroom("class:c")]),
    );
    client.accounts.mockResolvedValueOnce(
      accountsResponse([account(USER_A), account(USER_B), account("user:c")]),
    );
    await controller.reload();
    controller.acceptReadback();
    expect(controller.state).toMatchObject({
      classDraft: null,
      classRecovery: null,
      accountDraft: null,
      accountRecovery: null,
      classCreateDraft: null,
      classCreateRecovery: null,
      accountCreateDraft: null,
      accountCreateRecovery: null,
      problem: null,
    });
    controller.resumeClassCreateDraft(CENTER_A, "class:c");
    controller.resumeAccountCreateDraft(CENTER_A, "user:c");
    expect(controller.state.classCreateDraft).toBeNull();
    expect(controller.state.accountCreateDraft).toBeNull();
    await controller.selectClass(CLASS_B);
    controller.selectAccount(USER_B);
    expect(controller.state).toMatchObject({ classId: CLASS_B, accountId: USER_B });

    client.classes.mockRejectedValueOnce(failure("load"));
    await controller.loadClasses();
    controller.acceptReadback();
    expect(controller.state.problem).toBeNull();
  });

  it("keeps a pending class switch while create drafts exist without a selected class", async () => {
    const { client, controller } = await openTwoClassCenter();
    client.createClass.mockRejectedValueOnce(failure("uncertain"));
    await controller.createClass("class:c", "Created");
    await controller.selectClass(CLASS_A);
    expect(controller.state.pendingClassId).toBe(CLASS_A);
    await controller.loadClasses();
    expect(controller.state.pendingClassId).toBe(CLASS_A);

    client.createAccount.mockRejectedValueOnce(failure("uncertain"));
    await controller.createAccount(accountInput);
    controller.selectAccount(USER_A);
    expect(controller.state.pendingAccountId).toBe(USER_A);
    await controller.loadAccounts();
    expect(controller.state.pendingAccountId).toBe(USER_A);
  });
});
