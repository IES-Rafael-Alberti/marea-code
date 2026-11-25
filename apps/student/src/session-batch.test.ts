import { ApprovalIdSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentBatchTurn,
  AgentEvent,
  ApprovalPrompt,
  ApprovalReply,
  BatchAction,
} from "./contracts.js";
import { batchSummary, isBatchApproval } from "./session-batch.js";
import { createFixtureController, FixtureAgent } from "./student.fixture.js";

const command = (index: number, text: string): BatchAction => ({
  index,
  kind: "operation",
  request: {
    approvalId: ApprovalIdSchema.parse(`review-batch:batch-${String(index)}`),
    tool: "execute",
    arguments: { command: text },
    summary: `Run ${text}`,
  },
});

const WRITE: BatchAction = {
  index: 1,
  kind: "write",
  approvalId: ApprovalIdSchema.parse("review-batch:batch-1"),
  path: "notes.txt",
  content: "Notas",
  summary: "Create notes.",
};
const QUESTION: BatchAction = {
  index: 0,
  kind: "questions",
  request: {
    interruptId: "review-batch:batch-0",
    questions: [{ text: "¿Lista?", choices: [], required: true }],
  },
};

class BatchAgent extends FixtureAgent {
  readonly batches: AgentBatchTurn[] = [];
  constructor(private readonly actions: readonly BatchAction[]) {
    super();
  }
  override async *streamMessage(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield { type: "assistant-text-delta", text: "Voy a ejecutar" };
    yield { type: "assistant-text-delta", text: " dos comandos." };
    yield { type: "approval-batch-required", reviewId: "review-batch", actions: this.actions };
  }
  async *resumeBatch(turn: AgentBatchTurn): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.batches.push(turn);
    yield { type: "assistant-text-delta", text: " Hecho." };
    yield { type: "turn-completed" };
  }
}

function setup(actions: readonly BatchAction[], replies: readonly ApprovalReply[]) {
  const operations = {
    prepare: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn((request: { arguments: Readonly<Record<string, string>> }) =>
      Promise.resolve(`ran ${request.arguments.command ?? ""}`),
    ),
  };
  const agent = new BatchAgent(actions);
  const fixture = createFixtureController({ agent, operations });
  const prompts: ApprovalPrompt[] = [];
  const queue = [...replies];
  fixture.studentInterface.confirmWrite = vi.fn((prompt: ApprovalPrompt) => {
    prompts.push(prompt);
    return Promise.resolve(queue.shift() ?? "rejected");
  });
  return { agent, fixture, operations, prompts };
}

async function send(subject: ReturnType<typeof setup>): Promise<void> {
  await subject.fixture.controller.start("Synthetic project");
  await subject.fixture.controller.sendMessage(
    "message:batch",
    "Mira",
    new AbortController().signal,
  );
}

const serverEvents = (fixture: ReturnType<typeof createFixtureController>, type: string) =>
  [...fixture.server.events.values()].filter((event) => event.eventType === type);

describe("several approvals from one model message", () => {
  it("asks each action in order with its position and runs both when approved", async () => {
    const subject = setup([command(0, "cd src"), command(1, "dir")], ["approved", "approved"]);
    await send(subject);
    expect(subject.prompts.map((prompt) => prompt.batch)).toEqual([
      { position: 1, total: 2, remaining: ["execute dir"] },
      { position: 2, total: 2, remaining: [] },
    ]);
    expect(subject.operations.execute).toHaveBeenCalledTimes(2);
    expect(subject.agent.batches[0]?.assistantText).toBe("Voy a ejecutar dos comandos.");
    expect(subject.agent.batches[0]?.decisions).toEqual([
      { kind: "operation", decision: "approved", reason: undefined, result: "ran cd src" },
      { kind: "operation", decision: "approved", reason: undefined, result: "ran dir" },
    ]);
    expect(serverEvents(subject.fixture, "approval-requested")).toHaveLength(2);
    expect(serverEvents(subject.fixture, "approval-resolved")).toHaveLength(2);
    expect(serverEvents(subject.fixture, "turn-ended").at(-1)).toMatchObject({
      state: "completed",
    });
  });

  it("runs only the approved action and keeps asking after a rejection", async () => {
    const subject = setup(
      [command(0, "cd src"), command(1, "del main.py")],
      ["approved", { decision: "rejected", reason: "No borres nada." }],
    );
    await send(subject);
    expect(subject.operations.execute).toHaveBeenCalledTimes(1);
    expect(subject.agent.batches[0]?.decisions[1]).toEqual({
      kind: "operation",
      decision: "rejected",
      reason: "No borres nada.",
      result: null,
    });
  });

  it("approves the remaining actions of the batch after approve all, with events for each", async () => {
    const subject = setup(
      [command(0, "a"), command(1, "b"), command(2, "c")],
      [{ decision: "approved", remaining: true }],
    );
    await send(subject);
    expect(subject.prompts).toHaveLength(1);
    expect(subject.operations.execute).toHaveBeenCalledTimes(3);
    expect(serverEvents(subject.fixture, "approval-requested")).toHaveLength(3);
    expect(
      serverEvents(subject.fixture, "approval-resolved").map((event) =>
        "decision" in event ? event.decision : null,
      ),
    ).toEqual(["approved", "approved", "approved"]);
  });

  it("asks questions inside a mixed batch even after approve all, and stops on cancel", async () => {
    const question: BatchAction = {
      index: 1,
      kind: "questions",
      request: {
        interruptId: "review-batch:batch-1",
        questions: [{ text: "¿Qué estructura usarías?", choices: [], required: true }],
      },
    };
    const subject = setup(
      [command(0, "dir"), question],
      [{ decision: "approved", remaining: true }],
    );
    const ask = vi.fn().mockResolvedValue({ type: "answers", values: ["Una lista"] });
    Object.assign(subject.fixture.studentInterface, { askQuestions: ask });
    await send(subject);
    expect(ask).toHaveBeenCalledOnce();
    expect(subject.agent.batches[0]?.decisions[1]).toEqual({
      kind: "questions",
      values: ["Una lista"],
    });
    const cancelled = setup([QUESTION], []);
    Object.assign(cancelled.fixture.studentInterface, {
      askQuestions: vi.fn().mockResolvedValue({ type: "cancel" }),
    });
    await send(cancelled);
    expect(cancelled.agent.batches).toEqual([]);
    expect(serverEvents(cancelled.fixture, "turn-ended").at(-1)).toMatchObject({
      state: "cancelled",
    });
  });

  it("asks, records and applies a write inside a batch, with its position", async () => {
    const subject = setup([command(0, "dir"), WRITE], ["approved", "approved"]);
    await send(subject);
    expect(subject.prompts[1]).toMatchObject({
      path: "notes.txt",
      batch: { position: 2, total: 2, remaining: [] },
    });
    expect(subject.fixture.workspace.writes).toBe(1);
    expect(subject.agent.batches[0]?.decisions[1]).toMatchObject({
      kind: "write",
      decision: "approved",
      effect: { path: "notes.txt" },
    });
  });

  it("approves what follows a write approved with approve all", async () => {
    const subject = setup(
      [
        { ...WRITE, index: 0, approvalId: ApprovalIdSchema.parse("review-batch:batch-0") },
        command(1, "dir"),
      ],
      [{ decision: "approved", remaining: true }],
    );
    await send(subject);
    expect(subject.prompts).toHaveLength(1);
    expect(subject.operations.execute).toHaveBeenCalledOnce();
  });

  it("does not resume a batch whose turn was cancelled while deciding", async () => {
    const subject = setup([command(0, "dir")], ["approved"]);
    const controller = new AbortController();
    subject.operations.execute.mockImplementation(() => {
      controller.abort();
      return Promise.resolve("ran dir");
    });
    await subject.fixture.controller.start("Synthetic project");
    await subject.fixture.controller
      .sendMessage("message:batch", "Mira", controller.signal)
      .catch(() => undefined);
    expect(subject.agent.batches).toEqual([]);
  });

  it("applies a write without asking after approve all", async () => {
    const subject = setup([command(0, "dir"), WRITE], [{ decision: "approved", remaining: true }]);
    await send(subject);
    expect(subject.prompts).toHaveLength(1);
    expect(subject.fixture.workspace.writes).toBe(1);
  });

  it.each([
    ["the runtime cannot resume a batch", "The runtime cannot resume a batch of approvals."],
    ["the interface cannot ask questions", "Structured questions are not supported in this turn."],
    ["the interface gives no reply", "The question interface returned no reply."],
    ["operations are unavailable", "Operations are unavailable in this turn."],
  ])("fails the turn when %s", async (label, message) => {
    const actions =
      label.includes("operations") || label.includes("runtime") ? [command(0, "dir")] : [QUESTION];
    const agent = new BatchAgent(actions);
    if (label.includes("runtime")) Object.assign(agent, { resumeBatch: undefined });
    const fixture = label.includes("operations")
      ? createFixtureController({ agent })
      : createFixtureController({
          agent,
          operations: { prepare: vi.fn(), execute: vi.fn().mockResolvedValue("ran") },
        });
    fixture.studentInterface.confirmWrite = vi.fn().mockResolvedValue("approved");
    if (label.includes("no reply"))
      Object.assign(fixture.studentInterface, {
        askQuestions: vi.fn().mockResolvedValue(undefined),
      });
    if (label.includes("cannot ask"))
      Object.assign(fixture.studentInterface, { askQuestions: undefined });
    await fixture.controller.start("Synthetic project");
    await expect(
      fixture.controller.sendMessage("message:batch", "Mira", new AbortController().signal),
    ).rejects.toMatchObject({ cause: { message } });
  });

  it("names each action in one line and recognizes batch members by their identity", () => {
    expect(batchSummary(command(0, "dir"))).toBe("execute dir");
    expect(
      batchSummary({
        index: 0,
        kind: "operation",
        request: {
          approvalId: ApprovalIdSchema.parse("r:0"),
          tool: "delete",
          arguments: { path: "a.txt" },
          summary: "Delete",
        },
      }),
    ).toBe("delete a.txt");
    expect(
      batchSummary({
        index: 0,
        kind: "operation",
        request: {
          approvalId: ApprovalIdSchema.parse("r:0"),
          tool: "edit_file",
          arguments: {},
          summary: "Edit something",
        },
      }),
    ).toBe("edit_file Edit something");
    expect(
      batchSummary({
        index: 1,
        kind: "write",
        approvalId: ApprovalIdSchema.parse("r:1"),
        path: "main.py",
        content: "x",
        summary: "Write",
      }),
    ).toBe("write_file main.py");
    expect(batchSummary(QUESTION)).toBe("marea_ask_user");
    expect(isBatchApproval("review-batch:batch-12")).toBe(true);
    expect(isBatchApproval("review-batch:batch-1x")).toBe(false);
    expect(isBatchApproval("review-batch:batch-2")).toBe(true);
    expect(isBatchApproval("approval:1")).toBe(false);
    expect(isBatchApproval("review-batch")).toBe(false);
    expect(isBatchApproval("approval:command")).toBe(false);
  });
});
