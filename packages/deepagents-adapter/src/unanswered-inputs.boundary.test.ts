import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";

import type { RuntimeCheckpointSaver } from "./durable-checkpoint.boundary.js";
import { withUnansweredInputs } from "./unanswered-inputs.boundary.js";

function saver(
  tuples: readonly {
    readonly metadata: Readonly<Record<string, string | number>>;
    readonly config: RunnableConfig;
  }[],
): RuntimeCheckpointSaver {
  const list = async function* () {
    await Promise.resolve();
    yield* tuples;
  };
  return { list } as never;
}

const turn = { sessionId: "session", messageId: "message:new" };
const config = (id: string): RunnableConfig => ({ configurable: { checkpoint_id: id } });

describe("questions of turns that never completed", () => {
  it("carries the questions after the head, skipping unnamed and repeated ones", async () => {
    const states = new Map<string | undefined, object>([
      ["head", { values: { messages: [new HumanMessage({ content: "old", id: "message:old" })] } }],
      [
        "failed",
        {
          values: {
            messages: [
              new HumanMessage({ content: "old", id: "message:old" }),
              new HumanMessage({ content: "lost", id: "message:lost" }),
              new HumanMessage({ content: "unnamed" }),
              new AIMessage({ content: "partial", id: "message:ai" }),
              new HumanMessage({ content: "itself", id: "message:new" }),
            ],
          },
        },
      ],
    ]);
    const carried = await withUnansweredInputs(
      saver([
        { metadata: { step: 1 }, config: config("untagged") },
        { metadata: { messageId: "message:lost" }, config: config("failed") },
      ]),
      (candidate) =>
        Promise.resolve(states.get(candidate.configurable?.checkpoint_id as string | undefined)),
      turn,
      config("head"),
    );
    expect(carried).toHaveLength(1);
    expect(carried[0]).toBeInstanceOf(HumanMessage);
    expect(carried[0]).toMatchObject({ content: "lost", id: "message:lost" });
  });

  it("carries nothing without an unfinished turn or a readable state", async () => {
    const getState = (config: RunnableConfig | null) =>
      config === null
        ? Promise.reject(new Error("no checkpoint"))
        : Promise.resolve({ values: {} });
    await expect(withUnansweredInputs(saver([]), getState, turn, null)).resolves.toEqual([]);
    await expect(
      withUnansweredInputs(
        saver([{ metadata: { messageId: "message:head" }, config: config("head") }]),
        getState,
        turn,
        config("head"),
      ),
    ).resolves.toEqual([]);
    await expect(
      withUnansweredInputs(
        saver([{ metadata: { messageId: "message:lost" }, config: config("failed") }]),
        getState,
        turn,
        null,
      ),
    ).resolves.toEqual([]);
  });
});
