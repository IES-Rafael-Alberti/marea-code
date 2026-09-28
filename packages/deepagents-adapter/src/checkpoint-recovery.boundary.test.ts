import { join } from "node:path";

import type { RunnableConfig } from "@langchain/core/runnables";
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import { describe, expect, it, vi } from "vitest";

import { useTemporaryDirectories } from "./adapter.fixture.js";
import { DurableFileSaver, MemoryTurnSaver } from "./durable-checkpoint.boundary.js";

const temporaryRoot = useTemporaryDirectories("marea-checkpoint-recovery-");

describe("checkpoint recovery records", () => {
  it("does not recover session heads without a valid message identifier", async () => {
    for (const metadata of [{}, { messageId: 42 }]) {
      const saver = new MemoryTurnSaver();
      const tuple = await memoryCheckpointTuple(saver);
      vi.spyOn(saver, "list").mockImplementation(() =>
        checkpointTuples({
          ...tuple,
          metadata: { source: "input", step: -1, parents: {}, ...metadata },
        }),
      );
      const isCompleted = vi.fn(() => Promise.resolve(true));

      await expect(saver.findSessionHead("cleanup-session", isCompleted)).resolves.toBeNull();
      expect(isCompleted).not.toHaveBeenCalled();
    }
  });

  it("selects the latest checkpoint for exactly the requested session and message", async () => {
    const saver = new MemoryTurnSaver();
    await putCheckpoint(saver, "first-session", "target", "001");
    const latest = await putCheckpoint(saver, "first-session", "target", "002");
    await putCheckpoint(saver, "first-session", "other", "003");
    const second = await putCheckpoint(saver, "second-session", "target", "004");

    await expect(saver.findTurnCheckpoint("first-session", "target")).resolves.toEqual(latest);
    await expect(saver.findTurnCheckpoint("second-session", "target")).resolves.toEqual(second);
    await expect(saver.findTurnCheckpoint("second-session", "missing")).resolves.toBeNull();
  });

  it("cancels only the selected turn and removes all of its checkpoint writes", async () => {
    const saver = new MemoryTurnSaver();
    const retained = await putCheckpoint(saver, "retained-session", "target", "001");
    const first = await putCheckpoint(saver, "cancel-session", "target", "002");
    const second = await putCheckpoint(saver, "cancel-session", "target", "003");
    const unrelated = await putCheckpoint(saver, "cancel-session", "other", "004");
    for (const config of [retained, first, second, unrelated]) {
      await saver.putWrites(config, [["messages", "stored"]], "write-task");
    }
    const completed = {
      state: "completed" as const,
      events: [{ type: "turn-completed" as const }],
    };
    await saver.recordTurn("retained-session", "target", completed);
    await saver.recordTurn("cancel-session", "other", completed);
    await saver.recordTurn("cancel-session", "target", { state: "in-progress", events: [] });

    await saver.cancelTurn("cancel-session", "target", [{ type: "turn-cancelled" }]);

    await expect(saver.getTuple(first)).resolves.toBeUndefined();
    await expect(saver.getTuple(second)).resolves.toBeUndefined();
    await expect(saver.getTuple(retained)).resolves.toMatchObject({ config: retained });
    await expect(saver.getTuple(unrelated)).resolves.toMatchObject({ config: unrelated });
    expect(Object.keys(saver.writes).sort()).toEqual([
      '["cancel-session","","004"]',
      '["retained-session","","001"]',
    ]);
    expect(saver.findTurn("retained-session", "target")).toEqual(completed);
    expect(saver.findTurn("cancel-session", "other")).toEqual(completed);
    expect(saver.findTurn("cancel-session", "target")).toEqual({
      state: "cancelled",
      events: [{ type: "turn-cancelled" }],
    });

    await saver.cancelTurn("cancel-session", "other", [{ type: "turn-cancelled" }]);
    expect(Object.keys(saver.storage)).toEqual(["retained-session"]);
    expect(Object.keys(saver.writes)).toEqual(['["retained-session","","001"]']);
  });

  it("persists cancellation through a durable saver", async () => {
    const statePath = join(temporaryRoot(), "checkpoints.bin");
    const saver = new DurableFileSaver(statePath);
    await saver.recordTurn("cancel-session", "message:cancel", {
      state: "in-progress",
      events: [{ type: "assistant-text-delta", text: "partial" }],
    });

    await saver.cancelTurn("cancel-session", "message:cancel", [
      { type: "assistant-text-delta", text: "partial" },
      { type: "turn-cancelled" },
    ]);

    expect(new DurableFileSaver(statePath).findTurn("cancel-session", "message:cancel")).toEqual({
      state: "cancelled",
      events: [{ type: "assistant-text-delta", text: "partial" }, { type: "turn-cancelled" }],
    });
  });

  it("rejects malformed checkpoint references during cancellation cleanup", async () => {
    const invalidConfigs = [
      { configurable: { thread_id: "cleanup-session" } },
      {
        configurable: {
          thread_id: "missing-session",
          checkpoint_id: "checkpoint-cleanup",
          checkpoint_ns: "",
        },
      },
      {
        configurable: {
          thread_id: "cleanup-session",
          checkpoint_id: "checkpoint-cleanup",
          checkpoint_ns: "missing-namespace",
        },
      },
    ];

    for (const config of invalidConfigs) {
      const saver = new MemoryTurnSaver();
      const tuple = await memoryCheckpointTuple(saver);
      vi.spyOn(saver, "list").mockImplementation(() => checkpointTuples({ ...tuple, config }));

      await expect(
        saver.cancelTurn("cleanup-session", "message:cleanup", [{ type: "turn-cancelled" }]),
      ).rejects.toMatchObject({ code: "invalid-checkpoint-state" });
    }
  });

  it("cleans up a checkpoint whose namespace is omitted from its reference", async () => {
    const saver = new MemoryTurnSaver();
    const tuple = await memoryCheckpointTuple(saver);
    const config = {
      configurable: {
        thread_id: "cleanup-session",
        checkpoint_id: "checkpoint-cleanup",
      },
    };
    vi.spyOn(saver, "list").mockImplementation(() => checkpointTuples({ ...tuple, config }));

    await saver.cancelTurn("cleanup-session", "message:cleanup", [{ type: "turn-cancelled" }]);

    expect(saver.findTurn("cleanup-session", "message:cleanup")).toEqual({
      state: "cancelled",
      events: [{ type: "turn-cancelled" }],
    });
    expect(saver.storage).toEqual({});
  });
});

function putCheckpoint(
  saver: MemoryTurnSaver,
  sessionId: string,
  messageId: string,
  checkpointId: string,
): Promise<RunnableConfig> {
  return saver.put(
    { configurable: { thread_id: sessionId }, metadata: { messageId } },
    {
      v: 4,
      id: checkpointId,
      ts: "2026-09-07T10:00:00.000Z",
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    },
    { source: "input", step: -1, parents: {} },
  );
}

async function memoryCheckpointTuple(saver: MemoryTurnSaver): Promise<CheckpointTuple> {
  const config = await putCheckpoint(
    saver,
    "cleanup-session",
    "message:cleanup",
    "checkpoint-cleanup",
  );
  const tuple = await saver.getTuple(config);
  if (tuple === undefined) throw new Error("Expected a checkpoint tuple.");
  return tuple;
}

async function* checkpointTuples(tuple: CheckpointTuple): AsyncGenerator<CheckpointTuple> {
  await Promise.resolve();
  yield tuple;
}
