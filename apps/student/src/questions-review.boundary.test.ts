import { expect, it } from "vitest";
import { QUESTION_TOOL_NAME } from "@marea/deepagents-adapter";
import { harness, collect, message, approvalRequired } from "./deepagents-runtime.fixture.js";

const request = { interruptId: "q", questions: [{ text: "Why?", choices: [], required: true }] };
const pending = approvalRequired({
  reviewId: "q",
  toolName: QUESTION_TOOL_NAME,
  arguments: { questions: JSON.stringify(request.questions) },
});
const signal = () => new AbortController().signal;

it("binds the amended question to the checkpoint and preserves its exact assistant prefix", async () => {
  const test = harness();
  test.deep.messages = [{ type: "assistant-text-delta", text: "Before " }, pending];
  await collect(test.runtime.streamMessage(message(), signal()));
  await collect(
    test.runtime.resumeQuestions(
      { ...message(), assistantText: "Be", request, values: ["Because"] },
      signal(),
    ),
  );
  expect(test.deep.resumes[0]).toMatchObject({
    assistantText: "Be",
    reviewId: "q",
    toolName: QUESTION_TOOL_NAME,
    decision: {
      type: "amend",
      arguments: { questions: JSON.stringify(request.questions), answers: '["Because"]' },
    },
  });
  expect(test.deep.recoveries.at(-1)?.assistantText).toBe("Be");
});

it("rejects a missing, stale, unrelated or empty review before calling resume", async () => {
  const test = harness();
  const turn = { ...message(), request, values: ["Because"] };
  await expect(collect(test.runtime.resumeQuestions(turn, signal()))).rejects.toThrow(
    "no longer pending",
  );
  test.deep.startedMessageId = turn.messageId;
  for (const event of [approvalRequired({ reviewId: "q" }), { ...pending, reviewId: "stale" }]) {
    test.deep.messages = [event];
    await expect(collect(test.runtime.resumeQuestions(turn, signal()))).rejects.toThrow(
      "no longer pending",
    );
  }
  test.deep.forcedRecovery = {
    type: "completed",
    assistantText: "",
    events: [{ type: "turn-completed" }],
  };
  await expect(collect(test.runtime.resumeQuestions(turn, signal()))).rejects.toThrow(
    "no longer pending",
  );
  expect(test.deep.resumes).toEqual([]);
});
