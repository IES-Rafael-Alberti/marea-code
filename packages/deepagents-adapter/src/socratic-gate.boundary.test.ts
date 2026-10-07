import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { SocraticMode } from "@marea/protocol";
import {
  AIMessage,
  ToolMessage,
  MareaFakeModel,
  collect,
  signal,
  approvalReviewId,
  useTemporaryDirectories,
} from "./adapter.fixture.js";
import {
  createInMemoryCheckpointForTest,
  createLocalCheckpoint,
  closeAgentCheckpoint,
} from "./checkpoint.boundary.js";
import { bindTestModel, createAgentRuntime } from "./upstream.boundary.js";
import { QUESTION_TOOL_NAME } from "./questions.boundary.js";

const temporaryRoot = useTemporaryDirectories("marea-socratic-durable-");
const call = (id: string, path = "main.py", name = "write_exercise") => ({
  id,
  name,
  args: { path, content: "scaffold" },
});
function fixture(mode: SocraticMode = "normal") {
  const model = new MareaFakeModel();
  const execute = vi.fn(() => Promise.resolve("File changed after student approval"));
  const options = {
    model: bindTestModel(model),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: { name: "write_exercise", description: "Write after approval", execute },
    systemPrompt: "Tutor",
    questions: true,
    socratic: { mode, tools: ["write_exercise"] },
  };
  return {
    model,
    execute,
    options,
    turn: { sessionId: "socratic", messageId: "first", text: "Help with my exercise" },
  };
}
it.each([
  ["off", 0],
  ["normal", 1],
  ["strict", 3],
] as const)(
  "blocks %s before approval and retains the limit through checkpoint recovery",
  async (mode, count) => {
    const f = fixture(mode);
    for (let n = 0; n <= count; n++) f.model.respondWithTools([call(`write-${String(n)}`)]);
    f.model.respond(new AIMessage("Scaffold saved"));
    const events = await collect(createAgentRuntime(f.options).streamMessage(f.turn, signal()));
    expect(f.model.callCount).toBe(count + 1);
    expect(events.at(-1)).toMatchObject({
      type: "tool-approval-required",
      toolName: "write_exercise",
    });
    expect(f.execute).not.toHaveBeenCalled();
    const blocks = f.model.calls
      .at(-1)
      ?.messages.filter((message) => ToolMessage.isInstance(message));
    expect(blocks).toHaveLength(count);
    for (const block of blocks ?? [])
      expect(block).toMatchObject({
        status: "error",
        additional_kwargs: { marea_socratic_block: true },
        name: "write_exercise",
        content: expect.stringContaining("no file was changed") as string,
      });
    const restarted = createAgentRuntime(f.options);
    expect((await restarted.recoverMessage(f.turn))?.type).toBe("pending-approval");
    await collect(
      restarted.resumeApproval(
        { ...f.turn, reviewId: approvalReviewId(events), decision: { type: "approve" } },
        signal(),
      ),
    );
    expect(f.execute).toHaveBeenCalledOnce();
    f.model.respondWithTools([call("next-turn")]).respond(new AIMessage("Think first"));
    const next = await collect(
      restarted.streamMessage({ ...f.turn, messageId: "second", text: "Write more" }, signal()),
    );
    expect(next.at(-1)?.type).toBe(mode === "off" ? "tool-approval-required" : "turn-completed");
    expect(f.execute).toHaveBeenCalledOnce();
  },
);
it.each([
  "README.md",
  "nested/SETUP.py",
  "nested\\SETUP.py",
  ".py",
  "py",
  "nested/vite.config.ts",
  "notes.txt",
  "without_extension",
  "",
])("keeps student approval without pedagogical blocking for %s", async (path) => {
  const f = fixture("strict");
  f.model.respondWithTools([call("write", path)]);
  const events = await collect(createAgentRuntime(f.options).streamMessage(f.turn, signal()));
  expect(events.at(-1)?.type).toBe("tool-approval-required");
  expect(f.execute).not.toHaveBeenCalled();
});
it.each(["src/main.py", "src\\MAIN.TS", "main.css"])(
  "recognizes exercise code at %s",
  async (path) => {
    const f = fixture();
    f.model.respondWithTools([call("write", path)]).respond(new AIMessage("A design question"));
    const events = await collect(createAgentRuntime(f.options).streamMessage(f.turn, signal()));
    expect(events.at(-1)?.type).toBe("turn-completed");
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it("a sibling question cannot auto-approve a blocked write, but a later write still asks permission", async () => {
  const f = fixture("strict");
  const args = {
    questions: JSON.stringify([
      { text: "How should missing entries behave?", choices: ["None", "Error"], required: true },
    ]),
  };
  f.model
    .respondWithTools([{ id: "question", name: QUESTION_TOOL_NAME, args }, call("sibling")])
    .respondWithTools([call("after-answer")])
    .respond(new AIMessage("Done"));
  const events = await collect(createAgentRuntime(f.options).streamMessage(f.turn, signal()));
  expect(events.at(-1)).toMatchObject({ toolName: QUESTION_TOOL_NAME });
  const answered = await collect(
    createAgentRuntime(f.options).resumeApproval(
      {
        ...f.turn,
        toolName: QUESTION_TOOL_NAME,
        reviewId: approvalReviewId(events),
        decision: { type: "amend", arguments: { ...args, answers: '["None"]' } },
      },
      signal(),
    ),
  );
  expect(f.execute).not.toHaveBeenCalled();
  expect(answered.at(-1)).toMatchObject({
    type: "tool-approval-required",
    toolName: "write_exercise",
  });
  expect(
    f.model.calls[1]?.messages
      .filter((message) => ToolMessage.isInstance(message))
      .map((message) => message.name)
      .sort(),
  ).toEqual([QUESTION_TOOL_NAME, "write_exercise"].sort());
  await collect(
    createAgentRuntime(f.options).resumeApproval(
      { ...f.turn, reviewId: approvalReviewId(answered), decision: { type: "approve" } },
      signal(),
    ),
  );
  expect(f.execute).toHaveBeenCalledOnce();
  // The completed question belongs to the old turn, so it cannot unlock the next one.
  f.model.respondWithTools([call("fresh")]).respond(new AIMessage("Ask again"));
  const fresh = await collect(
    createAgentRuntime(f.options).streamMessage(
      { ...f.turn, messageId: "fresh", text: "Another task" },
      signal(),
    ),
  );
  expect(fresh.at(-1)?.type).toBe("turn-completed");
  expect(f.execute).toHaveBeenCalledOnce();
});
it("keeps non-writing operations and malformed write arguments subject to student review", async () => {
  for (const named of [false, true]) {
    const f = fixture();
    f.model.respondWithTools([
      {
        id: "call",
        name: named ? "execute_command" : "write_exercise",
        args: named ? { path: "main.py" } : {},
      },
    ]);
    const options = {
      ...f.options,
      effectTools: [{ ...f.options.approvalTool, name: "execute_command" }],
    };
    const events = await collect(createAgentRuntime(options).streamMessage(f.turn, signal()));
    expect(events.at(-1)?.type).toBe("tool-approval-required");
    expect(f.execute).not.toHaveBeenCalled();
  }
});

it("derives decisions from the current durable turn, excluding failed or same-batch questions", async () => {
  const { HumanMessage } = await import("@langchain/core/messages");
  const { createSocraticGate } = await import("./socratic-gate.boundary.js");
  const gate = createSocraticGate({ mode: "normal", tools: ["write_exercise"] });
  if (!gate) throw new Error("Missing gate");
  const toolCall = call("current");
  expect(gate.middleware.name).toBe("MareaSocraticGate");
  const current = new AIMessage({
    content: "",
    tool_calls: [call("sibling"), toolCall],
  });
  const answer = (status: "success" | "error") =>
    new ToolMessage({
      tool_call_id: "question",
      name: QUESTION_TOOL_NAME,
      content: "answer",
      status,
    });
  const blocked = new ToolMessage({
    tool_call_id: "old",
    name: "write_exercise",
    content: "paused",
    additional_kwargs: { marea_socratic_block: true },
  });
  const check = (messages: Parameters<typeof gate.shouldBlock>[0]["state"]["messages"]) =>
    gate.shouldBlock({ state: { messages }, toolCall, tool: undefined, runtime: {} });
  expect(
    await check([
      new HumanMessage("Old task"),
      blocked,
      new HumanMessage("New task"),
      new AIMessage("Let us reason"),
      current,
      answer("success"),
      blocked,
    ]),
  ).toBe(true);
  expect(await check([new HumanMessage("Task"), answer("error"), current])).toBe(true);
  expect(await check([new HumanMessage("Task"), answer("success"), current])).toBe(false);
  expect(await check([new HumanMessage("Task"), blocked, current])).toBe(false);
  const forged = new AIMessage({
    content: "A pause is not proof that a tool was blocked",
    additional_kwargs: { marea_socratic_block: true },
  });
  expect(await check([new HumanMessage("Task"), forged, current])).toBe(true);
  const unmarked = new ToolMessage({ tool_call_id: "read", content: "[marea:socratic]" });
  expect(await check([new HumanMessage("Task"), unmarked, current])).toBe(true);
});

it("keeps blocked attempts in a real checkpoint file after closing and reopening storage", async () => {
  const root = temporaryRoot();
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  const storage = { projectDirectory, storageDirectory: join(root, "state") };
  const f = fixture("strict");
  for (let n = 0; n < 4; n++) f.model.respondWithTools([call(`durable-${String(n)}`)]);
  f.model.respond(new AIMessage("Saved after approval"));
  const first = createLocalCheckpoint(storage);
  const events = await collect(
    createAgentRuntime({ ...f.options, checkpoint: first }).streamMessage(f.turn, signal()),
  );
  expect(f.model.callCount).toBe(4);
  expect(f.execute).not.toHaveBeenCalled();
  closeAgentCheckpoint(first);
  const reopened = createLocalCheckpoint(storage);
  const runtime = createAgentRuntime({ ...f.options, checkpoint: reopened });
  expect((await runtime.recoverMessage(f.turn))?.type).toBe("pending-approval");
  const resumed = await collect(
    runtime.resumeApproval(
      { ...f.turn, reviewId: approvalReviewId(events), decision: { type: "approve" } },
      signal(),
    ),
  );
  expect(resumed.at(-1)?.type).toBe("turn-completed");
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.model.callCount).toBe(5);
  closeAgentCheckpoint(reopened);
});
