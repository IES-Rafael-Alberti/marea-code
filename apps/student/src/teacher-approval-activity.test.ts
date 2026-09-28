import { ApprovalIdSchema } from "@marea/protocol";
import { expect, it } from "vitest";
import { createFixtureController, FixtureAgent } from "./student.fixture.js";
it.each([0, 65_536, 65_537])(
  "records the actual bounded proposal (%s) and rejection reason",
  async (length) => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield {
        type: "write-approval-required",
        approvalId: ApprovalIdSchema.parse("approval:proposal"),
        path: "main.py",
        summary: "Try this",
        content: "x".repeat(length),
      };
    };
    const fixture = createFixtureController({ agent });
    fixture.studentInterface.confirmWrite = () =>
      Promise.resolve({ decision: "rejected", reason: "r".repeat(4097) });
    await fixture.controller.start("Project");
    await fixture.controller.sendMessage("message:proposal", "Help", new AbortController().signal);
    expect([...fixture.server.events.values()]).toContainEqual(
      expect.objectContaining({
        eventType: "approval-requested",
        path: "main.py",
        content: "x".repeat(Math.min(length, 65_536)),
        truncated: length > 65_536,
      }),
    );
    expect([...fixture.server.events.values()]).toContainEqual(
      expect.objectContaining({
        eventType: "approval-resolved",
        reason: "r".repeat(4096),
        decision: "rejected",
      }),
    );
    expect(fixture.workspace.writes).toBe(0);
  },
);
