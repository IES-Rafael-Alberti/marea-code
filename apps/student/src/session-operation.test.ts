import { StudentHttpError } from "./http-client.boundary.js";
import { expect, it, vi } from "vitest";
import { ApprovalIdSchema } from "@marea/protocol";
import type { AgentEvent } from "./contracts.js";
import type { OperationTurn } from "./operation-contracts.js";
import { createFixtureController, FixtureAgent } from "./student.fixture.js";
class OperationAgent extends FixtureAgent {
  override async *streamMessage(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield {
      type: "operation-approval-required",
      approvalId: ApprovalIdSchema.parse("approval:command"),
      tool: "execute",
      arguments: { command: "printf synthetic" },
      summary: "Run a synthetic command",
    };
  }
  async *resumeOperation(turn: OperationTurn): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield {
      type: "assistant-text-delta",
      text: turn.decision === "approved" ? "Executed" : "Rejected",
    };
    yield { type: "turn-completed" };
  }
}
it.each(["approved", "rejected"] as const)(
  "persists %s operation review before any effect and logs the terminal outcome",
  async (decision) => {
    const operations = {
      prepare: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue("result"),
    };
    const fixture = createFixtureController({ agent: new OperationAgent(), operations });
    fixture.studentInterface.confirmWrite = vi.fn().mockResolvedValue(decision);
    await fixture.controller.start("Synthetic project");
    operations.execute.mockImplementation(() => {
      expect([...fixture.server.events.values()]).toContainEqual(
        expect.objectContaining({ eventType: "approval-resolved", decision: "approved" }),
      );
      return Promise.resolve("result");
    });
    await fixture.controller.sendMessage("message:operation", "Run", new AbortController().signal);
    expect(operations.execute).toHaveBeenCalledTimes(decision === "approved" ? 1 : 0);
    const tools = [...fixture.server.events.values()].filter(
      (event) => event.eventType === "tool-started" || event.eventType === "tool-finished",
    );
    expect(tools).toMatchObject(
      decision === "approved"
        ? [
            {
              eventType: "tool-started",
              callId: "approval:command",
              name: "execute",
              arguments: JSON.stringify({ command: "printf synthetic" }, null, 2),
            },
            {
              eventType: "tool-finished",
              callId: "approval:command",
              failed: false,
              result: "result",
            },
          ]
        : [],
    );
    expect([...fixture.server.events.values()].at(-1)).toMatchObject({
      eventType: "turn-ended",
      state: "completed",
    });
    await fixture.controller.sendMessage("message:operation", "Run", new AbortController().signal);
    expect(operations.execute).toHaveBeenCalledTimes(decision === "approved" ? 1 : 0);
  },
);
it("keeps student evidence distinct from agent effects and supplies frozen context to the model", async () => {
  const evidence = {
    start: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockResolvedValue("+student change"),
    capture: vi.fn().mockResolvedValue(undefined),
    beginAgent: vi.fn().mockResolvedValue(undefined),
  };
  const agent = new FixtureAgent();
  const f = createFixtureController({ agent, evidence });
  await f.controller.start("Evidence");
  await f.controller.sendMessage("message:evidence", "Explain", new AbortController().signal);
  expect(agent.messageTurns[0]?.text).toContain("<student-work-evidence>");
  expect(agent.messageTurns[0]?.text).toContain("+student change");
  expect(evidence.capture).toHaveBeenNthCalledWith(1, "student", "message:evidence");
  expect(evidence.capture).toHaveBeenLastCalledWith("student", "message:evidence");
  expect(evidence.beginAgent).toHaveBeenCalledWith("message:evidence");
  expect(evidence.capture).toHaveBeenCalledWith("agent", "message:evidence");
  expect(
    [...f.server.events.values()].find((event) => event.eventType === "student-message"),
  ).toMatchObject({ content: "Explain" });
});
it("retains an approved decision after interrupted delivery and never prompts twice", async () => {
  const operations = {
    prepare: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue("result"),
  };
  const f = createFixtureController({ agent: new OperationAgent(), operations });
  const confirm = vi.spyOn(f.studentInterface, "confirmWrite").mockResolvedValue("approved");
  await f.controller.start("Synthetic");
  const append = f.server.appendRunEvents.bind(f.server);
  let lose = true;
  vi.spyOn(f.server, "appendRunEvents").mockImplementation(async (token, request) => {
    const response = await append(token, request);
    if (lose && request.events.some((event) => event.eventType === "approval-resolved")) {
      lose = false;
      throw new StudentHttpError(503, "unavailable", true);
    }
    return response;
  });

  await expect(
    f.controller.sendMessage("message:operation", "Run", new AbortController().signal),
  ).rejects.toThrow();
  await f.controller.sendMessage("message:operation", "Run", new AbortController().signal);
  expect(confirm).toHaveBeenCalledOnce();
  expect(
    [...f.server.events.values()].filter((event) => event.eventType === "approval-resolved"),
  ).toMatchObject([{ decision: "approved" }]);
});
it("rejects a requested operation when the executor or runtime resume port is missing", async () => {
  const agent = new OperationAgent();
  const f = createFixtureController({ agent });
  await f.controller.start("Missing executor");
  await expect(
    f.controller.sendMessage("message:missing", "Run", new AbortController().signal),
  ).rejects.toMatchObject({ cause: { message: "Operations are unavailable in this turn." } });
  const withoutResume = new FixtureAgent();
  withoutResume.streamMessage = agent.streamMessage.bind(agent);
  const operations = { prepare: vi.fn(), execute: vi.fn() };
  const g = createFixtureController({ agent: withoutResume, operations });
  await g.controller.start("Missing runtime");
  await expect(
    g.controller.sendMessage("message:missing", "Run", new AbortController().signal),
  ).rejects.toThrow();
  expect(operations.prepare).not.toHaveBeenCalled();
});
it.each(["edit_file", "execute"] as const)(
  "records explicit rejection of %s, including a reason, without effects",
  async (tool) => {
    const agent = new OperationAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield {
        type: "operation-approval-required",
        approvalId: ApprovalIdSchema.parse("approval:review"),
        tool,
        arguments: { path: "main.ts" },
        summary: "Review this operation",
      };
    };
    const operations = { prepare: vi.fn().mockResolvedValue(undefined), execute: vi.fn() };
    const f = createFixtureController({ agent, operations });
    vi.spyOn(f.studentInterface, "confirmWrite").mockResolvedValue({
      decision: "rejected",
      reason: "I want to do it myself",
    });
    await f.controller.start("Rejected operation");
    await f.controller.sendMessage("message:rejected", "Try", new AbortController().signal);
    expect(operations.execute).not.toHaveBeenCalled();
    expect([...f.server.events.values()]).toContainEqual(
      expect.objectContaining({
        eventType: "approval-resolved",
        reason: "I want to do it myself",
        decision: "rejected",
      }),
    );
  },
);
it("enforces teacher policy before preparing or asking about an operation", async () => {
  const operations = { prepare: vi.fn(), execute: vi.fn() };
  const f = createFixtureController({ agent: new OperationAgent(), operations });
  const open = f.server.openRun.bind(f.server);
  vi.spyOn(f.server, "openRun").mockImplementation(async (...args) => {
    const response = await open(...args);
    return {
      ...response,
      snapshot: {
        ...response.snapshot,
        teacherToolPolicy: {
          version: "tools:denied",
          restrictions: [{ tool: "execute", effect: "deny" }],
        },
      },
    };
  });
  await f.controller.start("Denied operation");
  await expect(
    f.controller.sendMessage("message:denied", "Run", new AbortController().signal),
  ).rejects.toThrow();
  expect(operations.prepare).not.toHaveBeenCalled();
  expect(f.studentInterface.approvals).toBe(0);
});
it("does not attribute later student changes to an already recorded write on retry", async () => {
  const { ModelStreamError } = await import("@marea/deepagents-adapter");
  const evidence = {
    start: vi.fn().mockResolvedValue(undefined),
    capture: vi.fn().mockResolvedValue(undefined),
    beginAgent: vi.fn().mockResolvedValue(undefined),
  };
  const agent = new FixtureAgent();
  const resume = agent.resumeApproval.bind(agent);
  let fail = true;
  agent.resumeApproval = async function* (...args) {
    if (fail) {
      fail = false;
      throw new ModelStreamError({
        code: "unavailable",
        message: "Synthetic model interruption",
        retryable: true,
      });
    }
    yield* resume(...args);
  };
  const f = createFixtureController({ agent, evidence });
  await f.controller.start("Recorded effect");
  await expect(
    f.controller.sendMessage("message:effect", "Write", new AbortController().signal),
  ).rejects.toThrow();
  await f.controller.sendMessage("message:effect", "Write", new AbortController().signal);
  expect(evidence.beginAgent).toHaveBeenCalledOnce();
  expect(evidence.capture.mock.calls.filter(([actor]) => actor === "agent")).toHaveLength(1);
  expect(f.workspace.writes).toBe(1);
});
it.each([new Error("Synthetic command failure"), "unstructured failure"])(
  "reports actual execution before an operation and its failure before the turn fails: %s",
  async (failure) => {
    const operations = { prepare: vi.fn().mockResolvedValue(undefined), execute: vi.fn() };
    const f = createFixtureController({ agent: new OperationAgent(), operations });
    vi.spyOn(f.studentInterface, "confirmWrite").mockResolvedValue("approved");
    await f.controller.start("Failed command");
    const rejected = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
    operations.execute.mockImplementation(() => {
      expect(f.studentInterface.events.at(-1)).toMatchObject({
        type: "tool-started",
        name: "execute",
      });
      expect([...f.server.events.values()].at(-1)).toMatchObject({
        eventType: "tool-started",
        name: "execute",
      });
      return rejected();
    });
    await expect(
      f.controller.sendMessage("message:tool-failure", "Run", new AbortController().signal),
    ).rejects.toThrow();
    const expected =
      failure instanceof Error ? failure.message : "The operation failed without an error.";
    expect(f.studentInterface.events).toContainEqual(
      expect.objectContaining({ type: "tool-finished", failed: true, result: expected }),
    );
    expect([...f.server.events.values()]).toContainEqual(
      expect.objectContaining({ eventType: "tool-finished", failed: true, result: expected }),
    );
  },
);
it.each(["active", "closing"] as const)(
  "captures final student work only when closing an %s run",
  async (phase) => {
    const evidence = {
      start: vi.fn().mockResolvedValue(undefined),
      capture: vi.fn().mockResolvedValue(undefined),
      beginAgent: vi.fn().mockResolvedValue(undefined),
    };
    const f = createFixtureController({ evidence });
    await f.controller.start("Final evidence");
    if (phase === "closing") await f.localSession.beginClose("student-exit");
    await f.controller.close();
    if (phase === "active") expect(evidence.capture).toHaveBeenCalledExactlyOnceWith("student");
    else expect(evidence.capture).not.toHaveBeenCalled();
  },
);

it("forwards the full streaming prefix to an operation resume", async () => {
  const agent = new OperationAgent();
  const original = agent.streamMessage.bind(agent);
  agent.streamMessage = async function* () {
    yield { type: "assistant-text-delta", text: "Reviewing " };
    yield { type: "assistant-text-delta", text: "the command" };
    yield* original();
  };
  const resume = vi.spyOn(agent, "resumeOperation");
  const operations = {
    prepare: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue("result"),
  };
  const f = createFixtureController({ agent, operations });
  await f.controller.start("Prefix");
  await f.controller.sendMessage("message:prefix", "Run", new AbortController().signal);
  expect(resume.mock.calls[0]?.[0].assistantText).toBe("Reviewing the command");
});
it("forbids operational effects during startup even with an installed executor", async () => {
  const { StartupFixtureAgent, StartupFixtureServer } = await import("./startup.fixture.js");
  const agent = new StartupFixtureAgent();
  const operation = new OperationAgent();
  agent.streamStartup = () => operation.streamMessage();
  const operations = { prepare: vi.fn(), execute: vi.fn() };
  const evidence = {
    start: vi.fn().mockResolvedValue(undefined),
    capture: vi.fn().mockResolvedValue(undefined),
    beginAgent: vi.fn(),
    context: vi.fn(),
  };
  const f = createFixtureController({
    agent,
    server: new StartupFixtureServer(),
    operations,
    evidence,
  });
  await f.controller.start("Readonly startup");
  await expect(f.controller.sendStartup(new AbortController().signal)).rejects.toMatchObject({
    cause: { message: "Operations are unavailable in this turn." },
  });
  expect(operations.prepare).not.toHaveBeenCalled();
  expect(evidence.context).not.toHaveBeenCalled();
});
it("stops before awaiting decision delivery when cancellation follows durable write review", async () => {
  const f = createFixtureController();
  const abort = new AbortController();
  await f.controller.start("Cancel durable review");
  const resolve = f.localSession.resolveApproval.bind(f.localSession);
  vi.spyOn(f.localSession, "resolveApproval").mockImplementation(async (...args) => {
    const saved = await resolve(...args);
    abort.abort();
    return saved;
  });
  const never = Promise.withResolvers<undefined>();
  const append = f.server.appendRunEvents.bind(f.server);
  vi.spyOn(f.server, "appendRunEvents").mockImplementation(async (...args) => {
    if (args[1].events.some((event) => event.eventType === "approval-resolved"))
      await never.promise;
    return append(...args);
  });
  try {
    await f.controller.sendMessage("message:cancel-review", "Write", abort.signal);
    expect(f.workspace.writes).toBe(0);
    expect(f.studentInterface.events.at(-1)).toMatchObject({ type: "turn-cancelled" });
  } finally {
    never.resolve(undefined);
  }
});
