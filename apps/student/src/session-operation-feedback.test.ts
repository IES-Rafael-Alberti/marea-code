import { ApprovalIdSchema } from "@marea/protocol";
import { WorkspaceError } from "@marea/workspace-backend";
import { expect, it, vi } from "vitest";
import * as z from "zod";

import type { AgentEvent } from "./contracts.js";
import { OperationRejectedError } from "./operation-feedback.boundary.js";
import type { OperationTurn } from "./operation-contracts.js";
import { createFixtureController, FixtureAgent } from "./student.fixture.js";
import { StaleReviewError } from "./workspace-writer.js";

class EditAgent extends FixtureAgent {
  readonly resumed: OperationTurn[] = [];
  override async *streamMessage(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield {
      type: "operation-approval-required",
      approvalId: ApprovalIdSchema.parse("approval:edit"),
      tool: "edit_file",
      arguments: { path: "a.txt", old_string: "x", new_string: "y" },
      summary: "Edit a file",
    };
  }
  async *resumeOperation(turn: OperationTurn): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.resumed.push(turn);
    yield { type: "turn-completed" };
  }
}

const zodFailure = (() => {
  const parsed = z.object({ path: z.string() }).safeParse({});
  if (parsed.success) throw new Error("Expected a failure.");
  return parsed.error;
})();

it.each([
  [
    new OperationRejectedError("The text to replace must occur exactly once."),
    "occur exactly once",
  ],
  [new WorkspaceError("not-found", "read"), "does not exist"],
  [zodFailure, "The arguments are invalid: path"],
])(
  "returns a request the model got wrong to the model as a rejection: %s",
  async (failure, expected) => {
    const operations = { prepare: vi.fn().mockRejectedValue(failure), execute: vi.fn() };
    const agent = new EditAgent();
    const f = createFixtureController({ agent, operations });
    const confirm = vi.spyOn(f.studentInterface, "confirmWrite");
    await f.controller.start("Edit");
    await f.controller.sendMessage("message:edit", "Edit", new AbortController().signal);
    expect(confirm).not.toHaveBeenCalled();
    expect(operations.execute).not.toHaveBeenCalled();
    expect(agent.resumed).toHaveLength(1);
    expect(agent.resumed[0]).toMatchObject({ decision: "rejected", result: null });
    expect(agent.resumed[0]?.reason).toContain(expected);
  },
);

it("still fails the turn when preparing an operation fails for the machine", async () => {
  const operations = {
    prepare: vi.fn().mockRejectedValue(new WorkspaceError("filesystem-failure", "read")),
    execute: vi.fn(),
  };
  const agent = new EditAgent();
  const f = createFixtureController({ agent, operations });
  await f.controller.start("Edit");
  await expect(
    f.controller.sendMessage("message:edit", "Edit", new AbortController().signal),
  ).rejects.toThrow();
  expect(agent.resumed).toHaveLength(0);
});

it("gives the model the failure of an approved edit that no longer applies and keeps the turn", async () => {
  const operations = {
    prepare: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockRejectedValue(new StaleReviewError()),
  };
  const agent = new EditAgent();
  const f = createFixtureController({ agent, operations });
  vi.spyOn(f.studentInterface, "confirmWrite").mockResolvedValue("approved");
  await f.controller.start("Edit");
  await f.controller.sendMessage("message:edit", "Edit", new AbortController().signal);
  expect(agent.resumed[0]).toMatchObject({
    decision: "approved",
    result: "The file changed after review.",
  });
  expect(f.studentInterface.events).toContainEqual(
    expect.objectContaining({
      type: "tool-finished",
      failed: true,
      result: "The file changed after review.",
    }),
  );
});
