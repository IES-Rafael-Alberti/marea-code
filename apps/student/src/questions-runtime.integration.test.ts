import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeAgentCheckpoint, QUESTION_TOOL_NAME } from "@marea/deepagents-adapter";
import { interruptFixture } from "./interrupt-runtime.fixture.js";
import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import { collect, message } from "./deepagents-runtime.fixture.js";

it("offers questions through the real model gateway and recovers the student's pending interrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marea-questions-"));
  const { requests, open, model } = await interruptFixture(
    directory,
    QUESTION_TOOL_NAME,
    {
      questions: JSON.stringify([{ text: "Pick", choices: ["A", "B"], required: true }]),
    },
    "I received B",
  );
  let checkpoint = open();
  try {
    const first = createDeepAgentsStudentRuntime({ checkpoint, model });
    const events = await collect(first.streamMessage(message(), new AbortController().signal));
    const event = events.find((entry) => entry.type === "questions-required");
    expect(event?.request.questions).toEqual([
      { text: "Pick", choices: ["A", "B"], required: true },
    ]);
    if (event === undefined) throw new Error("The runtime did not request questions.");
    closeAgentCheckpoint(checkpoint);
    checkpoint = open();
    const restarted = createDeepAgentsStudentRuntime({ checkpoint, model });
    expect(await collect(restarted.streamMessage(message(), new AbortController().signal))).toEqual(
      events,
    );
    const turn = { ...message(), request: event.request, values: ["B"] };
    await expect(
      collect(restarted.resumeQuestions(turn, new AbortController().signal)),
    ).resolves.toContainEqual({ type: "assistant-text-delta", text: "I received B" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools.some((tool) => tool.name === QUESTION_TOOL_NAME)).toBe(true);
    expect(requests[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool", content: '{"answers":["B"]}' }),
    );
    await expect(
      collect(restarted.resumeQuestions(turn, new AbortController().signal)),
    ).rejects.toThrow("no longer pending");
    expect(requests).toHaveLength(2);
  } finally {
    closeAgentCheckpoint(checkpoint);
    await rm(directory, { recursive: true, force: true });
  }
});
