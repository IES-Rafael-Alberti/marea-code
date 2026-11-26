import { expect, it } from "vitest";

import {
  AIMessage,
  collect,
  MareaFakeModel,
  signal,
  ToolMessage,
  unusedTool,
} from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import { QUESTION_TOOL_NAME, questionsProblem } from "./questions.boundary.js";
import { bindTestModel, createAgentRuntime } from "./upstream.boundary.js";
import type { ApprovalTool } from "./contracts.js";

const checkedTool: ApprovalTool = {
  ...unusedTool,
  validate: (args) => (args.content === undefined ? "content is required." : null),
};

async function runInvalidCall(name: string, args: Record<string, string>, questions = false) {
  const model = new MareaFakeModel()
    .respondWithTools([{ id: "call-1", name, args }])
    .respond(new AIMessage("Corrected"));
  const runtime = createAgentRuntime({
    model: bindTestModel(model),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: checkedTool,
    systemPrompt: "Tutor",
    questions,
  });
  const events = await collect(
    runtime.streamMessage({ sessionId: "s", messageId: "m", text: "Go" }, signal()),
  );
  const result = model.calls[1]?.messages.filter((entry) => ToolMessage.isInstance(entry)).at(-1);
  return { events, result };
}

it("answers an invalid effect call as a tool error without asking for approval", async () => {
  const { events, result } = await runInvalidCall(checkedTool.name, { path: "a.txt" });
  expect(events.some((event) => event.type === "tool-approval-required")).toBe(false);
  expect(events).toContainEqual({ type: "turn-completed" });
  expect(result).toMatchObject({ status: "error", tool_call_id: "call-1" });
  expect(result?.content).toContain("content is required.");
  expect(result?.content).toContain("was not run");
});

it("answers a call whose arguments are not text as a tool error", async () => {
  const { events, result } = await runInvalidCall(checkedTool.name, {
    content: 1 as never,
  });
  expect(events.some((event) => event.type === "tool-approval-required")).toBe(false);
  expect(result?.content).toContain("Every argument must be text.");
});

it("still asks for approval when the arguments are valid", async () => {
  const { events } = await runInvalidCall(checkedTool.name, { path: "a.txt", content: "x" });
  expect(events.some((event) => event.type === "tool-approval-required")).toBe(true);
});

it("answers malformed questions as a tool error instead of asking the student", async () => {
  const { events, result } = await runInvalidCall(QUESTION_TOOL_NAME, { questions: "[]" }, true);
  expect(events.some((event) => event.type === "tool-approval-required")).toBe(false);
  expect(result?.content).toContain("questions is invalid");
});

it("describes why a questions call cannot be shown", () => {
  expect(questionsProblem({})).toBe(
    "questions is required: a JSON array of {text, choices, required}.",
  );
  expect(questionsProblem({ questions: "{" })).toBe(
    "questions must be valid JSON: an array of {text, choices, required}.",
  );
  expect(questionsProblem({ questions: "[]" })).toContain("questions is invalid: ");
  expect(questionsProblem({ questions: '[{"text":"","choices":[],"required":true}]' })).toContain(
    "0.text",
  );
  expect(
    questionsProblem({ questions: '[{"text":"Why?","choices":[],"required":true}]' }),
  ).toBeNull();
});
