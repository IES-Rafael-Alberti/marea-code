import { RequestIdSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { openClass } from "./governance-controller-test-support.fixture.js";
import {
  CLASS_A,
  CLASS_B,
  CENTER_A,
  CENTER_B,
  USER_A,
  USER_B,
  VERSION_A,
  VERSION_B,
  account,
  classroom,
} from "./governance-controller.fixture.js";

const REQUEST_ID = RequestIdSchema.parse("request:controller");

describe("governance administrator controller repair regressions", () => {
  it("accepts an account create readback and rejects a removed pending center", async () => {
    const { client, controller } = await openClass();
    client.createAccount.mockRejectedValueOnce(
      Object.assign(new Error("uncertain"), { code: "uncertain" }),
    );
    await controller.createAccount({
      userId: "user:readback",
      displayName: "Readback account",
      login: "readback-account",
      role: "teacher",
      classId: null,
    });
    controller.resumeAccountCreateDraft(CENTER_A, "user:readback");
    client.accounts.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-accounts-response",
      items: [account(USER_A, CENTER_A), account("user:readback", CENTER_A)],
      nextAfterId: null,
    });
    await controller.loadAccounts();
    controller.acceptReadback();
    expect(controller.state.accountCreateDraft).toBeNull();

    controller.editClass("dirty");
    await controller.selectCenter(CENTER_B);
    client.centers.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-centers-response",
      items: [{ centerId: CENTER_A, displayName: "Center A", version: VERSION_A }],
      nextAfterId: null,
    });
    await controller.loadCenters();
    await controller.confirmCenterSwitch(true);
    expect(controller.state.centerId).toBe(CENTER_A);
  });

  it("keeps account drafts isolated when the same user is scoped to two centers", async () => {
    const { client, controller } = await openClass();
    client.accounts.mockImplementation(({ centerId }: { centerId: string }) =>
      Promise.resolve({
        protocolVersion: "0.1",
        requestId: REQUEST_ID,
        kind: "governance-accounts-response",
        items: [account(USER_A, centerId, centerId === CENTER_A ? "A" : "B")],
        nextAfterId: null,
      }),
    );
    controller.selectAccount(USER_A);
    controller.editAccount("A draft");
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    controller.selectAccount(USER_A);
    controller.editAccount("B draft");
    await controller.selectCenter(CENTER_A);
    await controller.confirmCenterSwitch(true);
    controller.selectAccount(USER_A);
    expect(controller.state.accountDraft?.displayName).toBe("A draft");
  });

  it("rejects mismatched mutation identities without adopting private rows", async () => {
    const { client, controller } = await openClass();
    client.createClass.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-class-created",
      classroom: classroom(CLASS_B, CENTER_B, "wrong center"),
    });
    await controller.createClass(CLASS_B, "Created class");
    expect(controller.state.classes.some((row) => row.displayName === "wrong center")).toBe(false);
    expect(controller.state.problem).toBe("invalid");

    await controller.loadAccounts();
    controller.selectAccount(USER_A);
    client.createAccount.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-account-created",
      account: account(USER_B, CENTER_B, "wrong center"),
    });
    await controller.createAccount({
      userId: USER_B,
      displayName: "Created account",
      login: "created-account",
      role: "teacher",
      classId: null,
    });
    expect(controller.state.accounts.some((row) => row.displayName === "wrong center")).toBe(false);
    expect(controller.state.problem).toBe("invalid");

    controller.editAccount("Renamed account");
    client.renameAccount.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-account-renamed",
      account: account(USER_B, CENTER_A, "wrong account"),
    });
    await controller.renameAccount();
    expect(controller.state.accounts.find((row) => row.userId === USER_A)?.displayName).not.toBe(
      "wrong account",
    );
    expect(controller.state.problem).toBe("invalid");

    client.changeAccountState.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-account-state-changed",
      account: account(USER_B, CENTER_A, "wrong state"),
    });
    await controller.changeAccountState("disabled");
    expect(controller.state.accounts.find((row) => row.userId === USER_A)?.displayName).not.toBe(
      "wrong state",
    );
    expect(controller.state.problem).toBe("invalid");

    client.revokeSessions.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-sessions-revoked",
      revocation: { userId: USER_B, version: VERSION_B, revokedAt: "2099-01-01T00:00:00Z" },
    });
    await controller.revokeSessions();
    expect(controller.state.lastRevocation).toBeNull();
    expect(controller.state.problem).toBe("invalid");

    client.changeMembership.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "governance-membership-changed",
      membership: {
        centerId: CENTER_A,
        classId: CLASS_B,
        userId: USER_A,
        role: "teacher",
        state: "active",
        version: VERSION_A,
      },
    });
    await controller.changeMembership(USER_A, "active");
    expect(controller.state.memberships[0]?.classId).toBe(CLASS_A);
    expect(controller.state.problem).toBe("invalid");
  });
});
