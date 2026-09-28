import { expect, it } from "vitest";
import { ApprovalIdSchema } from "@marea/protocol";
import { harness, message, approvalRequired, collect } from "./deepagents-runtime.fixture.js";
import type { OperationTurn } from "./operation-contracts.js";
const turn: OperationTurn = {
  ...message(),
  approvalId: ApprovalIdSchema.parse("approval:op"),
  tool: "execute",
  arguments: { command: "true" },
  summary: "Command",
  decision: "approved",
  result: "recorded",
};
it("refuses unavailable operations and approval without a durable result", async () => {
  const f = harness();
  const enabled = harness(true);
  if (f.runtime.resumeOperation === undefined || enabled.runtime.resumeOperation === undefined)
    throw new Error("Missing operation bridge");
  await expect(
    collect(f.runtime.resumeOperation(turn, new AbortController().signal)),
  ).rejects.toThrow("unavailable");
  await expect(
    collect(
      enabled.runtime.resumeOperation({ ...turn, result: null }, new AbortController().signal),
    ),
  ).rejects.toThrow("recorded result");
});
it.each([undefined, "Explicit student reason"])(
  "forwards rejected operations with reason %s",
  async (reason) => {
    const f = harness(true);
    f.deep.messages = [approvalRequired({ toolName: "marea_execute", arguments: turn.arguments })];
    await collect(f.runtime.streamMessage(message(), new AbortController().signal));
    if (f.runtime.resumeOperation === undefined) throw new Error("Missing operation bridge");
    await collect(
      f.runtime.resumeOperation(
        { ...turn, decision: "rejected", result: null, reason, assistantText: "prefix" },
        new AbortController().signal,
      ),
    );
    expect(f.deep.resumes[0]).toMatchObject({
      toolName: "marea_execute",
      assistantText: "prefix",
      decision: { type: "reject", reason: reason ?? "The student rejected this operation." },
    });
  },
);
it("omits denied tools from the actual runtime capability set", async () => {
  const f = harness(true);
  const input = message();
  const restricted = {
    ...input,
    snapshot: {
      ...input.snapshot,
      teacherToolPolicy: {
        version: "tools:restricted",
        restrictions: [
          { tool: "execute", effect: "deny" as const },
          { tool: "edit_file", effect: "require-approval" as const },
        ],
      },
    },
  };
  await collect(f.runtime.streamMessage(restricted, new AbortController().signal));
  expect(f.options[0]?.effectTools?.map((tool) => tool.name)).toEqual([
    "marea_edit_file",
    "marea_delete",
  ]);
});

it.each([false, true])(
  "clears an unused operation capability after resume failure=%s",
  async (fail) => {
    const f = harness(true);
    f.deep.messages = [approvalRequired({ toolName: "marea_execute", arguments: turn.arguments })];
    await collect(f.runtime.streamMessage(message(), new AbortController().signal));
    f.deep.executeTool = null;
    f.deep.failResume = fail;
    if (f.runtime.resumeOperation === undefined) throw new Error("Missing operation bridge");
    const resumed = collect(f.runtime.resumeOperation(turn, new AbortController().signal));
    if (fail) await expect(resumed).rejects.toThrow("resume failed");
    else await expect(resumed).resolves.toEqual([{ type: "turn-completed" }]);
    const capability = f.options[0]?.effectTools?.find((tool) => tool.name === "marea_execute");
    await expect(capability?.execute(turn.arguments)).rejects.toThrow(
      "does not match its authorization",
    );
  },
);
it.each([undefined, "prefix"])(
  "preserves the assistant prefix across an operation and a subsequent write: %s",
  async (prefix) => {
    const f = harness(true);
    await collect(f.runtime.streamMessage(message(), new AbortController().signal));
    f.deep.resumeApproval = async function* () {
      await Promise.resolve();
      yield { type: "assistant-text-delta", text: " continuation" };
      yield approvalRequired();
    };
    if (f.runtime.resumeOperation === undefined) throw new Error("Missing operation bridge");
    await collect(
      f.runtime.resumeOperation(
        { ...turn, ...(prefix === undefined ? {} : { assistantText: prefix }) },
        new AbortController().signal,
      ),
    );
    f.deep.forcedRecovery = {
      type: "pending-approval",
      assistantText: (prefix ?? "") + " continuation",
      events: [approvalRequired()],
    };
    const { approval, effect } = await import("./deepagents-runtime.fixture.js");
    await collect(
      f.runtime.resumeApproval(approval("approved", effect), new AbortController().signal),
    );
    expect(f.deep.recoveries.at(-1)?.assistantText).toBe((prefix ?? "") + " continuation");
  },
);
