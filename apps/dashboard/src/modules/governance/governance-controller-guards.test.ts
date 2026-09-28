import { describe, expect, it } from "vitest";

import { GovernanceController } from "./governance-controller.js";
import {
  CLASS_A,
  CENTER_A,
  CENTER_B,
  USER_B,
  controllerClient,
} from "./governance-controller.fixture.js";

describe("governance administrator controller guards", () => {
  it("rejects malformed drafts, missing revisions and impossible membership transitions", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, () => undefined);
    await controller.load();
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    controller.editClass("");
    expect(controller.state.problem).toBe("invalid");
    controller.editAccount("");
    expect(controller.state.problem).toBe("invalid");
    await controller.changeMembership(USER_B, "revoked");
    expect(controller.state.problem).toBe("invalid");
    controller.setImportPackage(null);
    controller.setImportPackage({} as never);
    expect(controller.state.problem).toBe("invalid");
    await controller.previewClassImport();
    expect(client.previewClassImport).not.toHaveBeenCalled();

    client.classRevision.mockResolvedValueOnce({
      protocolVersion: "0.1",
      requestId: "request:controller",
      kind: "governance-class-revision-response",
      centerId: CENTER_A,
      classId: CLASS_A,
      teachingVersion: null,
    });
    await controller.selectCenter(CENTER_B);
    await controller.selectCenter(CENTER_A);
    await controller.selectClass(CLASS_A);
    await controller.exportClass();
    expect(controller.state.problem).toBe("invalid");
  });
});
