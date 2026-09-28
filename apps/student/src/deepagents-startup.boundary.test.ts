import { STARTUP_MESSAGE_ID } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import {
  checkpoint,
  collect,
  harness,
  message,
  model,
  runId,
  snapshot,
} from "./deepagents-runtime.fixture.js";

function startupSnapshot() {
  const value = snapshot();
  return { ...value, startup: { ...value.prompt, content: "Inspect and suggest an exercise." } };
}

describe("student internal startup bridge", () => {
  it("keeps startup and conversation contexts separate but binds both to one snapshot", async () => {
    const instance = harness();
    instance.deep.messages = [{ type: "assistant-text-delta", text: "Hello" }];
    const value = startupSnapshot();
    const turn = { messageId: STARTUP_MESSAGE_ID, runId, snapshot: value };
    const signal = new AbortController().signal;
    await collect(instance.runtime.streamStartup(turn, signal));
    expect(instance.deep.messageTurns[0]).toEqual({
      kind: "startup",
      messageId: STARTUP_MESSAGE_ID,
      sessionId: runId,
      assistantText: "",
      text: value.startup.content,
    });
    expect(instance.options[0]).toMatchObject({
      readOnly: true,
      systemPrompt: value.prompt.content,
    });
    instance.deep.messages = [{ type: "turn-completed" }];
    await collect(instance.runtime.streamStartup(turn, signal));
    expect(instance.deep.messageTurns[1]?.assistantText).toBe("Hello");
    await collect(instance.runtime.streamStartup({ ...turn, assistantText: "Explicit" }, signal));
    expect(instance.deep.messageTurns[2]?.assistantText).toBe("Explicit");
    await collect(instance.runtime.streamMessage(message(value), signal));
    expect(instance.options).toHaveLength(2);
    expect(instance.options[1]?.readOnly).toBe(false);
    await collect(instance.runtime.streamStartup(turn, signal));
    expect(instance.options).toHaveLength(2);
    expect(() =>
      instance.runtime.streamStartup(
        {
          ...turn,
          snapshot: { ...value, id: snapshot("snapshot:changed").id },
        },
        signal,
      ),
    ).toThrow("An active run cannot change its immutable snapshot.");
  });

  it("rejects a student identity, free mode or missing startup prompt", () => {
    const instance = harness();
    const turn = { messageId: STARTUP_MESSAGE_ID, runId, snapshot: startupSnapshot() };
    for (const invalid of [
      { ...turn, messageId: "message:student" },
      { ...turn, snapshot: { ...turn.snapshot, agentMode: "free" as const } },
      { ...turn, snapshot: snapshot() },
    ]) {
      expect(() => instance.runtime.streamStartup(invalid, new AbortController().signal)).toThrow(
        "No internal tutor startup is configured for this turn.",
      );
    }
    expect(instance.options).toEqual([]);
  });

  it("supplies captured read tools and allows read-only startup when writes are denied", async () => {
    const instance = harness();
    instance.deep.messages = [{ type: "turn-completed" }];
    const reader = {
      name: "marea_read_project" as const,
      description: "Read",
      execute: () => Promise.resolve("text"),
    };
    const readOnlyTools = vi.fn(() => [reader]);
    const runtime = createDeepAgentsStudentRuntime({
      checkpoint,
      model,
      readOnlyTools,
      createRuntime: (options) => {
        expect(options.readOnlyTools).toEqual([reader]);
        expect(options.readOnly).toBe(true);
        return instance.deep;
      },
    });
    const value = {
      ...startupSnapshot(),
      teacherToolPolicy: snapshot("snapshot:1", "deny").teacherToolPolicy,
    };
    await collect(
      runtime.streamStartup(
        { messageId: STARTUP_MESSAGE_ID, runId, snapshot: value },
        new AbortController().signal,
      ),
    );
    expect(readOnlyTools).toHaveBeenCalledExactlyOnceWith(runId, value);
  });
});
