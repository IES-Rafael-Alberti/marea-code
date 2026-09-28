import { describe, expect, it } from "vitest";

import {
  CENTER_A,
  CENTER_B,
  CLASS_A,
  exchange,
  failure,
  openTwoClassCenter,
} from "./governance-controller-test-support.fixture.js";

describe("governance controller staging and retained creates", () => {
  it("stages pasted package text only for a selected class and keeps a valid package on bad text", async () => {
    const { changed, controller } = await openTwoClassCenter();
    changed.mockClear();
    controller.stageImportText(JSON.stringify(exchange));
    expect(changed).not.toHaveBeenCalled();

    await controller.selectClass(CLASS_A);
    controller.stageImportText(JSON.stringify(exchange));
    expect(controller.state).toMatchObject({ importPackage: exchange, problem: null });
    for (const text of ["{", JSON.stringify({ ...exchange, format: "other" })]) {
      controller.stageImportText(text);
      expect(controller.state).toMatchObject({ importPackage: exchange, problem: "invalid" });
    }
  });

  it("lists every retained create draft of the selected center", async () => {
    const { changed, client, controller } = await openTwoClassCenter();
    expect(controller.state.pendingClassCreates).toEqual([]);
    client.createClass.mockRejectedValueOnce(failure("uncertain"));
    await controller.createClass("class:c", "Created");
    client.createAccount.mockRejectedValueOnce(failure("uncertain"));
    await controller.createAccount({
      userId: "user:c",
      displayName: "Created",
      login: "created-user",
      role: "student",
      classId: null,
    });
    expect(controller.state.pendingClassCreates).toEqual([
      { centerId: CENTER_A, classId: "class:c", displayName: "Created" },
    ]);
    expect(controller.state.pendingAccountCreates.map((draft) => draft.userId)).toEqual(["user:c"]);

    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    expect(controller.state.pendingClassCreates).toEqual([]);
    expect(controller.state.pendingAccountCreates).toEqual([]);
    await controller.selectCenter(CENTER_A);
    expect(controller.state.pendingClassCreates).toHaveLength(1);

    changed.mockClear();
    controller.dismissClassCreateDraft(CENTER_A, "class:c");
    controller.dismissAccountCreateDraft(CENTER_A, "user:c");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(controller.state.pendingClassCreates).toEqual([]);
    expect(controller.state.pendingAccountCreates).toEqual([]);
  });
});
