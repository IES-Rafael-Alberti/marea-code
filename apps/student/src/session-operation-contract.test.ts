import { expect, it, vi } from "vitest";
import { ApprovalIdSchema, MessageIdSchema } from "@marea/protocol";
import { resolveOperation } from "./session-operation.js";
import { createFixtureController, FixtureAgent, FixtureIds } from "./student.fixture.js";
import type { OperationRequest, OperationTurn } from "./operation-contracts.js";
import type { SessionTurnExecutorOptions } from "./session-turn-executor.js";
import type { AgentEvent } from "./contracts.js";
const identity = {
  messageId: MessageIdSchema.parse("message:direct-operation"),
  attemptId: "attempt:one",
};
const request: OperationRequest = {
  approvalId: ApprovalIdSchema.parse("approval:direct"),
  tool: "execute",
  arguments: { command: "printf synthetic" },
  summary: "Review command",
};
async function fixture() {
  const f = createFixtureController();
  const started = await f.controller.start("Direct operation");
  const active = { ...started, runToken: await f.controller.modelRunToken() };
  const resume = vi.fn(async function* (turn: OperationTurn): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    expect(turn.messageId).toBe(identity.messageId);
    yield { type: "turn-completed" };
  });
  const agent = Object.assign(new FixtureAgent(), { resumeOperation: resume });
  const confirm = vi.spyOn(f.studentInterface, "confirmWrite").mockResolvedValue("approved");
  const flush = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const evidence = {
    start: vi.fn().mockResolvedValue(undefined),
    capture: vi.fn().mockResolvedValue(undefined),
    beginAgent: vi.fn().mockResolvedValue(undefined),
  };
  const options: SessionTurnExecutorOptions = {
    agent,
    ids: new FixtureIds(),
    localSession: f.localSession,
    workspace: f.workspace,
    studentInterface: f.studentInterface,
    requireActiveRun: () => Promise.resolve(active),
    flushOutbox: flush,
    evidence,
  };
  const operations = {
    prepare: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue("recorded result"),
  };
  const abort = new AbortController();
  const resolve = (input = request, configuration = options, run = active) =>
    resolveOperation(
      configuration,
      operations,
      input,
      run,
      identity,
      "assistant prefix",
      abort.signal,
    );
  return { ...f, options, operations, abort, resolve, resume, confirm, flush, evidence, active };
}
async function consume(events: AsyncIterable<AgentEvent>) {
  const output = [];
  for await (const event of events) output.push(event);
  return output;
}
it.each([
  {
    tool: "execute" as const,
    arguments: { command: "printf synthetic" },
    path: "",
    summary: "printf synthetic",
  },
  { tool: "execute" as const, arguments: {}, path: "", summary: "Review command" },
  {
    tool: "edit_file" as const,
    arguments: { path: "main.ts", old_string: "a", new_string: "b" },
    path: "main.ts",
    summary: "Review command",
  },
])("presents exact arguments and resumes the reviewed $tool result", async (input) => {
  const f = await fixture();
  const operation = { ...request, tool: input.tool, arguments: input.arguments };
  await consume(await f.resolve(operation));
  expect(f.confirm).toHaveBeenCalledExactlyOnceWith({
    ...identity,
    approvalId: request.approvalId,
    toolName: input.tool,
    arguments: input.arguments,
    path: input.path,
    content: JSON.stringify(input.arguments, null, 2),
    summary: input.summary,
  });
  expect(f.resume).toHaveBeenCalledExactlyOnceWith(
    {
      ...f.active,
      ...identity,
      ...operation,
      assistantText: "assistant prefix",
      decision: "approved",
      reason: undefined,
      result: "recorded result",
    },
    f.abort.signal,
  );
  expect(f.evidence.beginAgent).toHaveBeenCalledExactlyOnceWith(identity.messageId);
  expect(f.evidence.capture).toHaveBeenCalledExactlyOnceWith("agent", identity.messageId);
});
it.each([65536, 65537])(
  "bounds review content at %s and normalizes a long rejection reason once",
  async (size) => {
    const f = await fixture();
    f.confirm.mockResolvedValue({ decision: "rejected", reason: "r".repeat(2049) });
    const overhead = JSON.stringify({ path: "main.ts", content: "" }, null, 2).length;
    const args = { path: "main.ts", content: "x".repeat(size - overhead) };
    await consume(
      await f.resolve({
        ...request,
        tool: "edit_file",
        arguments: args,
        summary: "s".repeat(2049),
      }),
    );
    expect(await f.localSession.pendingEvents(128)).toMatchObject([
      {
        eventType: "approval-requested",
        summary: "s".repeat(2048),
        content: JSON.stringify(args, null, 2).slice(0, 65536),
        truncated: size > 65536,
      },
      { eventType: "approval-resolved", reason: "r".repeat(2048) },
    ]);
    expect(await f.localSession.findApproval(request.approvalId)).toMatchObject({
      reason: "r".repeat(2048),
    });
    expect(f.resume.mock.calls[0]?.[0].reason).toBe("r".repeat(2048));
    expect(f.operations.execute).not.toHaveBeenCalled();
  },
);
it("requires a resume port and distinguishes unrelated denial from review-required policy", async () => {
  const f = await fixture();
  await expect(f.resolve(request, { ...f.options, agent: new FixtureAgent() })).rejects.toThrow(
    "cannot resume",
  );
  const permitted = {
    ...f.active,
    snapshot: {
      ...f.active.snapshot,
      teacherToolPolicy: {
        version: "tools:policy",
        restrictions: [
          { tool: "delete", effect: "deny" as const },
          { tool: "execute", effect: "require-approval" as const },
        ],
      },
    },
  };
  await consume(await f.resolve(request, f.options, permitted));
  const denied = {
    ...permitted,
    snapshot: {
      ...permitted.snapshot,
      teacherToolPolicy: {
        version: "tools:deny",
        restrictions: [{ tool: "execute", effect: "deny" as const }],
      },
    },
  };
  await expect(f.resolve(request, f.options, denied)).rejects.toThrow("teacher policy denies");
});
it("records cancellation before delivering a decision and never resumes a rejected interrupted turn", async () => {
  const f = await fixture();
  f.confirm.mockImplementation(async () => {
    f.abort.abort();
    await Promise.resolve();
    return "approved";
  });
  await expect(f.resolve()).rejects.toThrow();
  expect(await f.localSession.findApproval(request.approvalId)).toMatchObject({
    decision: "rejected",
  });
  expect(f.flush).toHaveBeenCalledTimes(1);
  expect(f.operations.execute).not.toHaveBeenCalled();
  expect(f.resume).not.toHaveBeenCalled();
  const g = await fixture();
  g.confirm.mockResolvedValue("rejected");
  const events = await g.resolve();
  g.abort.abort();
  await expect(consume(events)).rejects.toThrow();
  expect(g.resume).not.toHaveBeenCalled();
});
it("checks cancellation after decision upload and again before the effect starts", async () => {
  const f = await fixture();
  f.flush.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    f.abort.abort();
    await Promise.resolve();
  });
  await expect(f.resolve()).rejects.toThrow();
  expect(f.operations.execute).not.toHaveBeenCalled();
  const g = await fixture();
  const iterator = (await g.resolve())[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "tool-started" });
  g.abort.abort();
  expect((await iterator.next()).value).toMatchObject({ type: "tool-finished", failed: true });
  await expect(iterator.next()).rejects.toThrow();
  expect(g.operations.execute).not.toHaveBeenCalled();
});
it("labels an unstructured authorization failure without executing anything", async () => {
  const f = await fixture();
  f.confirm.mockRejectedValue("unstructured");
  await expect(f.resolve()).rejects.toThrow("Operation authorization failed.");
  expect(f.operations.execute).not.toHaveBeenCalled();
});
