import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./contracts.js";
import { MemoryTurnSaver } from "./durable-checkpoint.boundary.js";
import {
  cancelTurnWith,
  isCompletedGraphState,
  recordTurnWith,
  recoverGraphTurn,
  recoveryAfterPrefix,
} from "./recovery-state.boundary.js";

const graphTurn = { sessionId: "graph-session", messageId: "message:graph" };
const approval: Extract<AgentEvent, { readonly type: "tool-approval-required" }> = {
  type: "tool-approval-required",
  reviewId: "review-1",
  toolName: "confirm_change",
  arguments: { path: "notes.txt" },
  description: "Confirm the change.",
  allowedDecisions: ["approve", "amend", "reject"],
};

describe("graph recovery state", () => {
  it("rejects malformed, unrelated, ambiguous, and divergent graph state", async () => {
    const saver = await saverWithCheckpoint();

    await expect(recoverFrom(saver, {})).rejects.toMatchObject({
      code: "upstream-contract-changed",
    });
    await expect(
      recoverFrom(saver, graphState({ metadata: { messageId: "message:other" } })),
    ).rejects.toMatchObject({ code: "upstream-contract-changed" });
    await expect(
      recoverFrom(saver, graphState({ messages: { invalid: true } })),
    ).rejects.toMatchObject({ code: "upstream-contract-changed" });
    await expect(
      recoverFrom(
        saver,
        graphState({ messages: [new HumanMessage({ content: "other", id: "message:other" })] }),
      ),
    ).rejects.toMatchObject({ code: "upstream-contract-changed" });
    await expect(
      recoverFrom(
        saver,
        graphState({ tasks: [{ interrupts: [approvalInterrupt(), approvalInterrupt()] }] }),
      ),
    ).rejects.toMatchObject({ code: "upstream-contract-changed" });
    await expect(
      recoverFrom(saver, { ...graphState(), metadata: undefined }),
    ).rejects.toMatchObject({ code: "upstream-contract-changed" });
    await expect(recoverFrom(saver, { ...graphState(), tasks: [{}] })).rejects.toMatchObject({
      code: "upstream-contract-changed",
    });

    await recordJournal(saver, "journal");
    await expect(
      recoverFrom(saver, graphState({ messages: turnMessages("checkpoint") })),
    ).rejects.toMatchObject({ code: "upstream-contract-changed" });
  });

  it("reconciles missing and partial graph text with the turn journal", async () => {
    const saver = await saverWithCheckpoint();
    await saver.recordTurn(graphTurn.sessionId, graphTurn.messageId, {
      state: "in-progress",
      events: [{ type: "assistant-text-delta", text: "journal text" }, approval],
    });

    await expect(
      recoverFrom(saver, graphState({ messages: { invalid: true }, next: ["model"] })),
    ).resolves.toMatchObject({
      approval,
      assistantText: "journal text",
      events: [{ type: "assistant-text-delta", text: "journal text" }],
      replayText: "journal text",
      type: "in-progress",
    });
    await expect(
      recoverFrom(saver, graphState({ messages: turnMessages("journal"), next: ["model"] })),
    ).resolves.toMatchObject({
      assistantText: "journal text",
      replayText: " text",
      type: "in-progress",
    });

    await recordJournal(saver, "journal");
    await expect(
      recoverFrom(
        saver,
        graphState({ messages: turnMessages("journal extended"), next: ["model"] }),
      ),
    ).resolves.toMatchObject({
      assistantText: "journal extended",
      replayText: "",
      type: "in-progress",
    });
  });

  it("stops assistant extraction at the next student message", async () => {
    const saver = await saverWithCheckpoint();
    const recovered = await recoverFrom(
      saver,
      graphState({
        messages: [
          new HumanMessage({ content: "question", id: graphTurn.messageId }),
          new AIMessage(""),
          new SystemMessage("ignored non-assistant"),
          new AIMessage("answer"),
          new HumanMessage({ content: "next", id: "message:next" }),
          new AIMessage("must not be included"),
        ],
      }),
    );

    expect(recovered).toMatchObject({
      assistantText: "answer",
      events: [{ type: "assistant-text-delta", text: "answer" }, { type: "turn-completed" }],
      replayText: "",
      type: "completed",
    });
  });

  it("recognizes a task-only in-progress graph", async () => {
    const saver = await saverWithCheckpoint();

    await expect(
      recoverFrom(saver, graphState({ tasks: [{ interrupts: [] }] })),
    ).resolves.toMatchObject({ approval: null, replayText: "", type: "in-progress" });
  });
});

describe("journal-only recovery state", () => {
  it.each([
    ["completed", [{ type: "assistant-text-delta", text: "done" }], "turn-completed", ""],
    ["cancelled", [{ type: "assistant-text-delta", text: "stopped" }], "turn-cancelled", ""],
    ["in-progress", [{ type: "assistant-text-delta", text: "partial" }], undefined, "partial"],
    [
      "pending-approval",
      [{ type: "assistant-text-delta", text: "review" }, approval],
      undefined,
      "",
    ],
  ] as const)("recovers a %s journal", async (state, events, terminalType, replayText) => {
    const saver = new MemoryTurnSaver();
    await saver.recordTurn("journal-session", `message:${state}`, { state, events });

    const recovered = await recoverGraphTurn(
      () => Promise.reject(new Error("graph state must not be requested")),
      saver,
      { sessionId: "journal-session", messageId: `message:${state}` },
    );

    expect(recovered).toMatchObject({ type: state, replayText });
    expect(recovered?.checkpointConfig).toEqual({
      configurable: { thread_id: "journal-session" },
    });
    expect(recovered?.events).toEqual(
      terminalType === undefined ? events : [...events, { type: terminalType }],
    );
    if (terminalType !== undefined) expect(recovered?.events.at(-1)?.type).toBe(terminalType);
  });

  it("rejects a pending journal without its approval event", async () => {
    const saver = new MemoryTurnSaver();
    await saver.recordTurn("journal-session", "message:invalid", {
      state: "pending-approval",
      events: [],
    });

    await expect(
      recoverGraphTurn(() => Promise.resolve({}), saver, {
        sessionId: "journal-session",
        messageId: "message:invalid",
      }),
    ).rejects.toMatchObject({ code: "upstream-contract-changed" });
  });
});

describe("recovery state helpers", () => {
  it("classifies complete, runnable, and invalid graph states", () => {
    expect(isCompletedGraphState(graphState())).toBe(true);
    expect(isCompletedGraphState(graphState({ next: ["model"] }))).toBe(false);
    expect(isCompletedGraphState(graphState({ tasks: [{ interrupts: [] }] }))).toBe(false);
    expect(() => isCompletedGraphState({})).toThrow(
      expect.objectContaining({ code: "upstream-contract-changed" }),
    );
  });

  it("preserves prefixes and the original approval in journal updates", async () => {
    const saver = new MemoryTurnSaver();
    const turn = { sessionId: "record-session", messageId: "message:record" };
    await saver.recordTurn(turn.sessionId, turn.messageId, {
      state: "pending-approval",
      events: [approval],
    });

    await recordTurnWith(
      saver,
      turn,
      "prior ",
    )("completed", [{ type: "assistant-text-delta", text: "answer" }, { type: "turn-completed" }]);
    expect(saver.findTurn(turn.sessionId, turn.messageId)?.events).toEqual([
      { type: "assistant-text-delta", text: "prior " },
      approval,
      { type: "assistant-text-delta", text: "answer" },
      { type: "turn-completed" },
    ]);

    await recordTurnWith(saver, turn, "")("pending-approval", [approval]);
    expect(saver.findTurn(turn.sessionId, turn.messageId)?.events).toEqual([approval]);

    const fresh = { sessionId: "record-session", messageId: "message:fresh" };
    await recordTurnWith(saver, fresh, "")("completed", [{ type: "turn-completed" }]);
    expect(saver.findTurn(fresh.sessionId, fresh.messageId)?.events).toEqual([
      { type: "turn-completed" },
    ]);
  });

  it("prepends recovered text when cancelling a continued turn", async () => {
    const saver = new MemoryTurnSaver();
    const turn = { sessionId: "cancel-session", messageId: "message:cancel" };

    await cancelTurnWith(saver, turn, "prior")([{ type: "turn-cancelled" }]);

    expect(saver.findTurn(turn.sessionId, turn.messageId)).toEqual({
      state: "cancelled",
      events: [{ type: "assistant-text-delta", text: "prior" }, { type: "turn-cancelled" }],
    });

    const freshTurn = { sessionId: "cancel-session", messageId: "message:fresh-cancel" };
    await cancelTurnWith(saver, freshTurn, "")([{ type: "turn-cancelled" }]);
    expect(saver.findTurn(freshTurn.sessionId, freshTurn.messageId)).toEqual({
      state: "cancelled",
      events: [{ type: "turn-cancelled" }],
    });
  });

  it("removes a persisted prefix across assistant event boundaries", () => {
    const recovered = {
      approval: null,
      assistantText: "firstsecond",
      checkpointConfig: { configurable: { thread_id: "prefix-session" } },
      events: [
        { type: "assistant-text-delta" as const, text: "first" },
        { type: "assistant-text-delta" as const, text: "second" },
        { type: "turn-completed" as const },
      ],
      replayText: "",
      type: "completed" as const,
    };

    expect(recoveryAfterPrefix(recovered, "firstse")).toEqual({
      type: "completed",
      assistantText: "firstsecond",
      events: [{ type: "assistant-text-delta", text: "cond" }, { type: "turn-completed" }],
    });
    expect(() => recoveryAfterPrefix(recovered, "different")).toThrow(
      expect.objectContaining({
        code: "invalid-replay-prefix",
        message: "The persisted assistant text does not match the durable turn.",
      }),
    );
  });
});

async function saverWithCheckpoint(): Promise<MemoryTurnSaver> {
  const saver = new MemoryTurnSaver();
  await saver.put(
    {
      configurable: { thread_id: graphTurn.sessionId },
      metadata: { messageId: graphTurn.messageId },
    },
    {
      v: 4,
      id: "checkpoint-graph",
      ts: "2026-09-07T10:00:00.000Z",
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    },
    { source: "input", step: -1, parents: {} } satisfies CheckpointMetadata,
  );
  return saver;
}

function recoverFrom(saver: MemoryTurnSaver, state: object) {
  return recoverGraphTurn(() => Promise.resolve(state), saver, graphTurn);
}

function graphState(
  overrides: {
    readonly messages?: object;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly next?: readonly string[];
    readonly tasks?: readonly {
      readonly interrupts: readonly ReturnType<typeof approvalInterrupt>[];
    }[];
  } = {},
) {
  return {
    values: { messages: overrides.messages ?? turnMessages("") },
    next: overrides.next ?? [],
    tasks: overrides.tasks ?? [],
    metadata: overrides.metadata ?? { messageId: graphTurn.messageId },
  };
}

function turnMessages(text: string) {
  return [new HumanMessage({ content: "question", id: graphTurn.messageId }), new AIMessage(text)];
}

function recordJournal(saver: MemoryTurnSaver, text: string) {
  return saver.recordTurn(graphTurn.sessionId, graphTurn.messageId, {
    state: "in-progress",
    events: [{ type: "assistant-text-delta", text }],
  });
}

function approvalInterrupt() {
  return {
    id: "review-1",
    value: {
      actionRequests: [
        {
          name: "confirm_change",
          args: { path: "notes.txt" },
          description: "Confirm the change.",
        },
      ] as const,
      reviewConfigs: [
        {
          actionName: "confirm_change",
          allowedDecisions: ["approve", "edit", "reject"],
        },
      ] as const,
    },
  };
}
