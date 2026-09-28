import { expect, it } from "vitest";
import { createQuestionChannel } from "./question-channel.js";

const request = {
  interruptId: "q1",
  questions: [
    { text: "Why?", required: true, choices: [] },
    { text: "More?", required: false, choices: [] },
  ],
};

it("resolves only matching, complete answers once, copying the submitted values", async () => {
  const channel = createQuestionChannel();
  expect(channel.answer("q1", ["yes", ""])).toBe(false);
  const reply = channel.request(request);
  await expect(channel.request(request)).rejects.toThrow("Questions already pending.");
  expect(channel.answer("q2", ["yes", ""])).toBe(false);
  expect(channel.answer("q1", ["yes"])).toBe(false);
  expect(channel.answer("q1", ["yes", "", "extra"])).toBe(false);
  expect(channel.answer("q1", [" ", ""])).toBe(false);
  expect(channel.answer("q1", ["yes", "a".repeat(8193)])).toBe(false);
  const values = ["a".repeat(8192), ""];
  expect(channel.answer("q1", values)).toBe(true);
  values[0] = "changed";
  await expect(reply).resolves.toEqual({ type: "answers", values: ["a".repeat(8192), ""] });
  expect(channel.answer("q1", ["yes", ""])).toBe(false);
  channel.cancel();
});

it("cancels a pending interrupt and permits a subsequent request", async () => {
  const channel = createQuestionChannel();
  const first = channel.request(request);
  channel.cancel();
  await expect(first).resolves.toEqual({ type: "cancel" });
  const second = channel.request({ ...request, interruptId: "q2" });
  expect(channel.answer("q1", ["yes", ""])).toBe(false);
  expect(channel.answer("q2", ["yes", ""])).toBe(true);
  await expect(second).resolves.toEqual({ type: "answers", values: ["yes", ""] });
});
