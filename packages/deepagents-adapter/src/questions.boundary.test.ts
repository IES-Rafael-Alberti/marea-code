import { expect, it } from "vitest";
import {
  AIMessage,
  ToolMessage,
  MareaFakeModel,
  collect,
  signal,
  unusedTool,
} from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import { bindTestModel, createAgentRuntime } from "./upstream.boundary.js";
import {
  createQuestionTools,
  executeQuestion,
  parseQuestions,
  questionAnswers,
  QUESTION_TOOL_NAME,
} from "./questions.boundary.js";

const questions = [{ text: "Which design?", choices: ["A", "B"], required: true }];

it("validates bounded questions and answers, never accepting an unanswered required question", () => {
  expect(parseQuestions({ questions: JSON.stringify(questions) })).toEqual(questions);
  expect(executeQuestion({ questions: JSON.stringify(questions), answers: '["B"]' })).toBe(
    '{"answers":["B"]}',
  );
  expect(questionAnswers([{ text: "Optional", choices: [], required: false }], [""])).toEqual([""]);
  for (const args of [{}, { questions: "[]" }, { questions: "invalid" }])
    expect(() => parseQuestions(args)).toThrow();
  for (const values of [[], [" "], ["A", "B"], ["a".repeat(4097)]])
    expect(() => questionAnswers(questions, values)).toThrow();
  expect(() => executeQuestion({ questions: JSON.stringify(questions) })).toThrow();
  expect(() => questionAnswers(questions, [" "])).toThrow("A required answer is missing.");
});

it("checkpoints a real question tool, resumes the same interrupt and gives the model the student's answers", async () => {
  const model = new MareaFakeModel()
    .respondWithTools([
      { id: "q1", name: QUESTION_TOOL_NAME, args: { questions: JSON.stringify(questions) } },
    ])
    .respond(new AIMessage("Answer received"));
  const checkpoint = createInMemoryCheckpointForTest();
  const options = {
    model: bindTestModel(model),
    checkpoint,
    approvalTool: unusedTool,
    systemPrompt: "Ask a design question",
    questions: true,
  };
  const first = createAgentRuntime(options);
  const turn = { sessionId: "questions-session", messageId: "question-message", text: "Help" };
  const events = await collect(first.streamMessage(turn, signal()));
  const pending = events.find((event) => event.type === "tool-approval-required");
  expect(pending?.toolName).toBe(QUESTION_TOOL_NAME);
  if (pending === undefined) throw new Error("Missing question");
  const restarted = createAgentRuntime(options);
  expect((await restarted.recoverMessage(turn))?.type).toBe("pending-approval");
  const resume = {
    ...turn,
    toolName: QUESTION_TOOL_NAME,
    reviewId: pending.reviewId,
    decision: {
      type: "amend" as const,
      arguments: { questions: JSON.stringify(questions), answers: '["B"]' },
    },
  };
  await expect(
    collect(restarted.resumeApproval({ ...resume, reviewId: "stale" }, signal())),
  ).rejects.toMatchObject({ code: "approval-review-mismatch" });
  expect(await collect(restarted.resumeApproval(resume, signal()))).toContainEqual({
    type: "turn-completed",
  });
  expect(
    model.calls[1]?.messages.filter((entry) => ToolMessage.isInstance(entry)).at(-1)?.content,
  ).toBe('{"answers":["B"]}');
  expect((await restarted.recoverMessage(turn))?.type).toBe("completed");
  expect(() => restarted.resumeApproval({ ...resume, toolName: "unknown" }, signal())).toThrow(
    "not available",
  );
});

it("enforces every question payload boundary without narrowing valid student answers", () => {
  const question = {
    text: "x".repeat(4096),
    choices: Array.from({ length: 20 }, () => "x".repeat(1024)),
    required: false,
  };
  expect(
    parseQuestions({ questions: JSON.stringify(Array.from({ length: 12 }, () => question)) }),
  ).toHaveLength(12);
  const invalid = [
    [],
    Array.from({ length: 13 }, () => question),
    [{ ...question, text: "x".repeat(4097) }],
    [{ ...question, text: " " }],
    [{ ...question, choices: Array.from({ length: 21 }, () => "a") }],
    [{ ...question, choices: [""] }],
    [{ ...question, choices: ["x".repeat(1025)] }],
    [{ ...question, required: "yes" }],
    [{ ...question, extra: "unexpected" }],
  ];
  for (const input of invalid)
    expect(() => parseQuestions({ questions: JSON.stringify(input) })).toThrow();
  expect(
    parseQuestions({ questions: JSON.stringify([{ ...question, text: " trimmed " }]) })[0]?.text,
  ).toBe("trimmed");
  expect(questionAnswers(questions, ["x".repeat(4096)])).toEqual(["x".repeat(4096)]);
  expect(questionAnswers(questions, ["Other explanation"])).toEqual(["Other explanation"]);
  expect(() => executeQuestion({ questions: JSON.stringify(questions), answers: "[1]" })).toThrow();
});

it("offers bounded string arguments and explicit tool instructions only when enabled", () => {
  expect(createQuestionTools(false)).toEqual([]);
  const tools = createQuestionTools(true);
  expect(tools).toHaveLength(1);
  const ask = tools[0];
  if (ask === undefined) throw new Error("Missing question tool");
  expect(ask.name).toBe("marea_ask_user");
  expect(ask.description).toContain("Do not supply answers.");
  expect(
    ask.schema.safeParse({ questions: "x".repeat(65536), answers: "x".repeat(65536) }).success,
  ).toBe(true);
  expect(ask.schema.safeParse({ questions: "x".repeat(65537) }).success).toBe(false);
  expect(ask.schema.safeParse({ questions: "[]", answers: "x".repeat(65537) }).success).toBe(false);
});

it("cannot resume the question tool when that capability was not enabled", () => {
  const runtime = createAgentRuntime({
    model: bindTestModel(new MareaFakeModel()),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: unusedTool,
    systemPrompt: "Tutor",
  });
  expect(() =>
    runtime.resumeApproval(
      {
        sessionId: "s",
        messageId: "m",
        reviewId: "r",
        toolName: QUESTION_TOOL_NAME,
        decision: { type: "approve" },
      },
      signal(),
    ),
  ).toThrow("not available");
});
