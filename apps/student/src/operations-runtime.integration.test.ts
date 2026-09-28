import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeAgentCheckpoint } from "@marea/deepagents-adapter";
import { interruptFixture } from "./interrupt-runtime.fixture.js";
import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import { collect, message } from "./deepagents-runtime.fixture.js";

it.each(["edit_file", "execute", "delete"] as const)(
  "requires review and recovers %s without repeating the operation",
  async (tool) => {
    const directory = await mkdtemp(join(tmpdir(), "marea-operation-runtime-"));
    const arguments_ =
      tool === "execute"
        ? { command: "printf synthetic" }
        : tool === "delete"
          ? { path: "main.ts" }
          : { path: "main.ts", old_string: "old", new_string: "new" };
    const { requests, open, model } = await interruptFixture(
      directory,
      tool,
      arguments_,
      "Finished",
    );
    let checkpoint = open();
    try {
      const first = createDeepAgentsStudentRuntime({ checkpoint, model, operations: true });
      const events = await collect(first.streamMessage(message(), new AbortController().signal));
      const operation = events.find((event) => event.type === "operation-approval-required");
      expect(operation).toMatchObject({ tool, arguments: arguments_ });
      if (operation === undefined) throw new Error("No operation review");
      expect(requests).toHaveLength(1);
      closeAgentCheckpoint(checkpoint);
      checkpoint = open();
      const restarted = createDeepAgentsStudentRuntime({ checkpoint, model, operations: true });
      const recovered = await collect(
        restarted.streamMessage(message(), new AbortController().signal),
      );
      expect(recovered).toContainEqual(operation);
      if (restarted.resumeOperation === undefined) throw new Error("Missing operation support");
      const turn = {
        ...message(),
        ...operation,
        decision: "approved" as const,
        result: "recorded synthetic result",
      };
      const resumed = await collect(restarted.resumeOperation(turn, new AbortController().signal));
      expect(resumed).toContainEqual({ type: "assistant-text-delta", text: "Finished" });
      expect(
        resumed.filter((event) => event.type === "tool-started" || event.type === "tool-finished"),
      ).toEqual([]);
      expect(requests[1]?.messages).toContainEqual(
        expect.objectContaining({ role: "tool", content: "recorded synthetic result" }),
      );
      await collect(restarted.resumeOperation(turn, new AbortController().signal));
      expect(requests).toHaveLength(2);
    } finally {
      closeAgentCheckpoint(checkpoint);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
