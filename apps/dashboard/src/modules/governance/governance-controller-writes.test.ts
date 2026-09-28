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
  classroom,
  controllerClient,
  deferred,
  openTwoClassCenter,
} from "./governance-controller-test-support.fixture.js";

type Client = ReturnType<typeof controllerClient>;
const envelope = { protocolVersion: "0.1", requestId: "request:controller" } as const;

function classCreated(classId: string, centerId: string = CENTER_A, displayName = "Created") {
  return {
    ...envelope,
    kind: "governance-class-created" as const,
    classroom: classroom(classId, centerId, displayName),
  };
}

function classRenamed(classId: string, centerId: string = CENTER_A, version: string = VERSION_B) {
  return {
    ...envelope,
    kind: "governance-class-renamed" as const,
    classroom: { ...classroom(classId, centerId, "Renamed"), version },
  };
}

function accountCreated(userId: string, centerId: string = CENTER_A) {
  return {
    ...envelope,
    kind: "governance-account-created" as const,
    account: account(userId, centerId, "Created"),
  };
}

function accountRenamed(userId: string, centerId: string = CENTER_A, version: string = VERSION_B) {
  return {
    ...envelope,
    kind: "governance-account-renamed" as const,
    account: { ...account(userId, centerId, "Renamed"), version },
  };
}

function accountStateChanged(userId: string, centerId: string = CENTER_A) {
  return {
    ...envelope,
    kind: "governance-account-state-changed" as const,
    account: { ...account(userId, centerId), state: "disabled" as const },
  };
}

const createInput = {
  userId: USER_B,
  displayName: "Created",
  login: "created-user",
  role: "student" as const,
  classId: null,
};

describe("governance controller class writes", () => {
  it("drafts class edits only for a selected class with a valid name", async () => {
    const { changed, controller } = await openTwoClassCenter();
    changed.mockClear();
    controller.editClass("Draft");
    expect(changed).not.toHaveBeenCalled();
    await controller.selectClass(CLASS_A);
    controller.editClass("");
    expect(controller.state).toMatchObject({ classDraft: null, problem: "invalid" });
    controller.editClass("Draft");
    expect(controller.state).toMatchObject({
      classDraft: {
        centerId: CENTER_A,
        classId: CLASS_A,
        displayName: "Draft",
        expectedVersion: VERSION_A,
      },
      classRecovery: null,
      problem: null,
    });
  });

  it("validates class creation and adopts only a matching readback for the current center", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    await controller.load();
    await controller.createClass(CLASS_B, "Created");
    expect(controller.state.problem).toBe("invalid");

    const opened = await openTwoClassCenter();
    for (const [classId, name] of [
      ["bad id", "Created"],
      [CLASS_B, ""],
    ] as const) {
      await opened.controller.createClass(classId, name);
      expect(opened.controller.state.problem).toBe("invalid");
    }
    expect(opened.client.createClass).not.toHaveBeenCalled();

    opened.client.createClass.mockResolvedValueOnce(classCreated(CLASS_B, CENTER_B));
    await opened.controller.createClass(CLASS_B, "Created");
    expect(opened.controller.state).toMatchObject({
      problem: "invalid",
      classCreateDraft: { classId: CLASS_B },
    });
    opened.client.createClass.mockResolvedValueOnce(classCreated("class:c"));
    await opened.controller.createClass(CLASS_B, "Created");
    expect(opened.controller.state.problem).toBe("invalid");

    opened.controller.selectAccount(USER_A);
    opened.client.createClass.mockResolvedValueOnce(classCreated(CLASS_B));
    await opened.controller.createClass(CLASS_B, "Created");
    expect(opened.client.createClass).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, classId: CLASS_B, displayName: "Created", expectedVersion: null },
      expect.any(AbortSignal),
    );
    expect(opened.controller.state).toMatchObject({
      classId: CLASS_B,
      accountId: null,
      classCreateDraft: null,
      classCreateRecovery: null,
      classesLoaded: true,
      problem: null,
    });
    expect(opened.controller.state.classes.map((row) => row.displayName)).toEqual([
      "Physics",
      "Created",
    ]);

    opened.client.createClass.mockResolvedValueOnce(classCreated("class:c"));
    await opened.controller.createClass("class:c", "Third");
    expect(opened.controller.state.classes.map((row) => row.classId)).toEqual([
      CLASS_A,
      CLASS_B,
      "class:c",
    ]);
  });

  it("does not create classes before the class list loads, while busy or for a replaced center", async () => {
    const { client, controller } = await openTwoClassCenter();
    const classes = deferred<Awaited<ReturnType<Client["classes"]>>>();
    client.classes.mockImplementationOnce(() => classes.promise);
    const loading = controller.loadClasses();
    await controller.selectCenter(CENTER_B);
    await controller.createClass("class:c", "Created");
    expect(client.createClass).not.toHaveBeenCalled();
    classes.resolve(await controllerClient().classes({ centerId: CENTER_A, afterId: null }));
    await loading;

    const { client: busyClient, controller: busy } = await openTwoClassCenter();
    const created = deferred<Awaited<ReturnType<Client["createClass"]>>>();
    busyClient.createClass.mockImplementationOnce(() => created.promise);
    const creating = busy.createClass("class:c", "Created");
    await busy.createClass("class:d", "Other");
    expect(busyClient.createClass).toHaveBeenCalledTimes(1);
    await busy.selectCenter(CENTER_B);
    await busy.confirmCenterSwitch(true);
    created.resolve(classCreated("class:c"));
    await creating;
    expect(busy.state.centerId).toBe(CENTER_B);
    expect(busy.state.classes.some((row) => row.classId === "class:c")).toBe(false);
  });

  it("renames the selected class, clearing or rebasing its draft", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.renameClass();
    await controller.selectClass(CLASS_A);
    await controller.renameClass();
    expect(client.renameClass).not.toHaveBeenCalled();

    controller.editClass("Saved");
    client.renameClass.mockResolvedValueOnce(classRenamed(CLASS_A));
    await controller.renameClass();
    expect(controller.state.classDraft).toBeNull();
    expect(controller.state.classes[0]).toMatchObject({
      displayName: "Renamed",
      version: VERSION_B,
    });
    await controller.selectClass(CLASS_B);
    expect(controller.state.classId).toBe(CLASS_B);
    await controller.selectClass(CLASS_A);
    expect(controller.state.classDraft).toBeNull();

    controller.editClass("Submitted");
    const renamed = deferred<Awaited<ReturnType<Client["renameClass"]>>>();
    client.renameClass.mockImplementationOnce(() => renamed.promise);
    const renaming = controller.renameClass();
    await controller.renameClass();
    expect(client.renameClass).toHaveBeenCalledTimes(2);
    controller.editClass("Newer");
    renamed.resolve(classRenamed(CLASS_A, CENTER_A, "version:c"));
    await renaming;
    expect(controller.state.classDraft).toMatchObject({
      displayName: "Newer",
      expectedVersion: "version:c",
    });
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    await controller.selectClass(CLASS_A);
    expect(controller.state.classDraft).toMatchObject({
      displayName: "Newer",
      expectedVersion: "version:c",
    });
  });

  it("rebases the submitted class draft after readback acceptance removed it", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.editClass("Submitted");
    const renamed = deferred<Awaited<ReturnType<Client["renameClass"]>>>();
    client.renameClass.mockImplementationOnce(() => renamed.promise);
    const renaming = controller.renameClass();
    await controller.loadClasses();
    controller.acceptReadback();
    renamed.resolve(classRenamed(CLASS_A, CENTER_A, "version:c"));
    await renaming;
    expect(controller.state.classDraft).toMatchObject({
      displayName: "Submitted",
      expectedVersion: "version:c",
    });
  });

  it("rejects mismatched or stale class renames", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.editClass("Draft");
    for (const response of [classRenamed(CLASS_A, CENTER_B), classRenamed(CLASS_B)]) {
      client.renameClass.mockResolvedValueOnce(response);
      await controller.renameClass();
      expect(controller.state).toMatchObject({
        problem: "invalid",
        classDraft: { displayName: "Draft" },
      });
    }
    const renamed = deferred<Awaited<ReturnType<Client["renameClass"]>>>();
    client.renameClass.mockImplementationOnce(() => renamed.promise);
    const renaming = controller.renameClass();
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    renamed.resolve(classRenamed(CLASS_A));
    await renaming;
    expect(controller.state.classes[0]?.displayName).toBe("Physics");
  });
});

describe("governance controller account writes", () => {
  it("drafts account edits only for a selected account with a valid name", async () => {
    const { changed, controller } = await openTwoClassCenter();
    changed.mockClear();
    controller.editAccount("Draft");
    expect(changed).not.toHaveBeenCalled();
    controller.selectAccount(USER_A);
    controller.editAccount("");
    expect(controller.state).toMatchObject({ accountDraft: null, problem: "invalid" });
    controller.editAccount("Draft");
    expect(controller.state).toMatchObject({
      accountDraft: {
        centerId: CENTER_A,
        userId: USER_A,
        displayName: "Draft",
        expectedVersion: VERSION_A,
      },
      accountRecovery: null,
      problem: null,
    });
  });

  it("validates account creation and adopts only a matching readback", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    await controller.load();
    await controller.createAccount(createInput);
    expect(controller.state.problem).toBe("invalid");

    const opened = await openTwoClassCenter();
    for (const input of [
      { ...createInput, userId: "bad id" },
      { ...createInput, displayName: "" },
      { ...createInput, login: "" },
      { ...createInput, classId: "class:unknown" },
    ]) {
      await opened.controller.createAccount(input);
      expect(opened.controller.state.problem).toBe("invalid");
    }
    expect(opened.client.createAccount).not.toHaveBeenCalled();

    for (const response of [accountCreated(USER_B, CENTER_B), accountCreated("user:c")]) {
      opened.client.createAccount.mockResolvedValueOnce(response);
      await opened.controller.createAccount(createInput);
      expect(opened.controller.state).toMatchObject({
        problem: "invalid",
        accountCreateDraft: { userId: USER_B },
      });
    }

    opened.client.createAccount.mockResolvedValueOnce(accountCreated(USER_B));
    await opened.controller.createAccount({ ...createInput, classId: CLASS_A });
    expect(opened.client.createAccount).toHaveBeenLastCalledWith(
      { ...createInput, classId: CLASS_A, centerId: CENTER_A, expectedVersion: null },
      expect.any(AbortSignal),
    );
    expect(opened.controller.state).toMatchObject({
      accountId: USER_B,
      accountCreateDraft: null,
      accountCreateRecovery: null,
      problem: null,
    });
    expect(opened.controller.state.accounts.map((row) => row.displayName)).toEqual([
      "Teacher",
      "Created",
    ]);
  });

  it("does not create accounts before the account list loads or for a replaced center", async () => {
    const { client, controller } = await openTwoClassCenter();
    const accounts = deferred<Awaited<ReturnType<Client["accounts"]>>>();
    client.accounts.mockImplementationOnce(() => accounts.promise);
    const switching = controller.selectCenter(CENTER_B);
    await controller.createAccount(createInput);
    expect(client.createAccount).not.toHaveBeenCalled();
    accounts.resolve(await controllerClient().accounts({ centerId: CENTER_B, afterId: null }));
    await switching;

    const created = deferred<Awaited<ReturnType<Client["createAccount"]>>>();
    client.createAccount.mockImplementationOnce(() => created.promise);
    const creating = controller.createAccount({ ...createInput, userId: "user:c" });
    await controller.selectCenter(CENTER_A);
    await controller.confirmCenterSwitch(true);
    created.resolve(accountCreated("user:c", CENTER_B));
    await creating;
    expect(controller.state.accounts.some((row) => row.userId === "user:c")).toBe(false);
  });

  it("renames the selected account, clearing or rebasing its draft", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.renameAccount();
    controller.selectAccount(USER_A);
    await controller.renameAccount();
    expect(client.renameAccount).not.toHaveBeenCalled();

    controller.editAccount("Saved");
    client.renameAccount.mockResolvedValueOnce(accountRenamed(USER_A));
    await controller.renameAccount();
    expect(controller.state.accountDraft).toBeNull();
    expect(controller.state.accounts[0]).toMatchObject({
      displayName: "Renamed",
      version: VERSION_B,
    });
    controller.selectAccount(USER_B);
    expect(controller.state.accountId).toBe(USER_B);
    controller.selectAccount(USER_A);
    expect(controller.state.accountDraft).toBeNull();

    controller.editAccount("Submitted");
    const renamed = deferred<Awaited<ReturnType<Client["renameAccount"]>>>();
    client.renameAccount.mockImplementationOnce(() => renamed.promise);
    const renaming = controller.renameAccount();
    controller.editAccount("Newer");
    renamed.resolve(accountRenamed(USER_A, CENTER_A, "version:c"));
    await renaming;
    expect(controller.state.accountDraft).toMatchObject({
      displayName: "Newer",
      expectedVersion: "version:c",
    });
    controller.selectAccount(USER_B);
    controller.confirmAccountSwitch(true);
    controller.selectAccount(USER_A);
    expect(controller.state.accountDraft).toMatchObject({
      displayName: "Newer",
      expectedVersion: "version:c",
    });

    for (const response of [accountRenamed(USER_A, CENTER_B), accountRenamed(USER_B)]) {
      client.renameAccount.mockResolvedValueOnce(response);
      await controller.renameAccount();
      expect(controller.state.problem).toBe("invalid");
    }
    const stale = deferred<Awaited<ReturnType<Client["renameAccount"]>>>();
    client.renameAccount.mockImplementationOnce(() => stale.promise);
    const staleRename = controller.renameAccount();
    controller.selectAccount(USER_B);
    controller.confirmAccountSwitch(true);
    stale.resolve(accountRenamed(USER_A, CENTER_A, "version:d"));
    await staleRename;
    expect(controller.state.accountId).toBe(USER_B);
    expect(controller.state.accounts[0]?.version).toBe("version:c");
  });

  it("changes account state and revokes sessions for the selected account only", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.changeAccountState("disabled");
    await controller.revokeSessions();
    expect(client.changeAccountState).not.toHaveBeenCalled();
    expect(client.revokeSessions).not.toHaveBeenCalled();

    controller.selectAccount(USER_A);
    client.changeAccountState.mockResolvedValueOnce(accountStateChanged(USER_A));
    await controller.changeAccountState("disabled");
    expect(client.changeAccountState).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, userId: USER_A, state: "disabled", expectedVersion: VERSION_A },
      expect.any(AbortSignal),
    );
    expect(controller.state.accounts[0]?.state).toBe("disabled");

    for (const response of [accountStateChanged(USER_A, CENTER_B), accountStateChanged(USER_B)]) {
      client.changeAccountState.mockResolvedValueOnce(response);
      await controller.changeAccountState("active");
      expect(controller.state.problem).toBe("invalid");
    }

    await controller.revokeSessions();
    expect(client.revokeSessions).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, userId: USER_A, expectedVersion: VERSION_A },
      expect.any(AbortSignal),
    );
    expect(controller.state.lastRevocation?.userId).toBe(USER_A);
    client.revokeSessions.mockResolvedValueOnce({
      ...envelope,
      kind: "governance-sessions-revoked",
      revocation: { userId: USER_B, version: VERSION_B, revokedAt: "2099-01-01T00:00:00Z" },
    });
    await controller.revokeSessions();
    expect(controller.state.problem).toBe("invalid");

    const changedState = deferred<Awaited<ReturnType<Client["changeAccountState"]>>>();
    client.changeAccountState.mockImplementationOnce(() => changedState.promise);
    const changing = controller.changeAccountState("disabled");
    await controller.revokeSessions();
    expect(client.revokeSessions).toHaveBeenCalledTimes(2);
    controller.selectAccount(USER_B);
    changedState.resolve(accountStateChanged(USER_A));
    await changing;
    expect(controller.state.accountId).toBe(USER_B);
    expect(controller.state.problem).toBeNull();
  });
});
