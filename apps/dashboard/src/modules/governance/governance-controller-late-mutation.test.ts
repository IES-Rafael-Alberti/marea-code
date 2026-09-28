import { describe, expect, it } from "vitest";

import { openClass } from "./governance-controller-test-support.fixture.js";
import {
  CLASS_A,
  CLASS_B,
  CENTER_A,
  CENTER_B,
  classroom,
} from "./governance-controller.fixture.js";

describe("governance administrator controller", () => {
  it("discards a late mutation response after an explicitly confirmed center switch", async () => {
    const { client, controller } = await openClass();
    controller.editClass("Pending name");
    let resolveRename: (() => void) | undefined;
    client.renameClass.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRename = () => {
            resolve({
              protocolVersion: "0.1",
              requestId: "request:controller",
              kind: "governance-class-renamed",
              classroom: classroom(CLASS_A, CENTER_A, "Late response"),
            });
          };
        }),
    );
    const saving = controller.renameClass();
    await controller.selectCenter(CENTER_B);
    expect(controller.state.pendingCenterId).toBe(CENTER_B);
    await controller.confirmCenterSwitch(true);
    resolveRename?.();
    await saving;
    expect(controller.state.centerId).toBe(CENTER_B);
    expect(controller.state.classes[0]?.classId).toBe(CLASS_B);
    expect(controller.state.classes[0]?.displayName).not.toBe("Late response");
  });
});
