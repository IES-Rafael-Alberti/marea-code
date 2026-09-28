import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import { collect, MareaFakeModel, pairedToolCall, signal, unusedTool } from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import { AgentAdapterError, ReadOnlyToolInputError, type ReadOnlyTool } from "./contracts.js";
import { createReadOnlyTools } from "./read-tools.boundary.js";
import type { ToolLifecycleEvent } from "./tool-events.boundary.js";
import { bindTestModel, createAgentRuntime } from "./upstream.boundary.js";

const reader: ReadOnlyTool = {
  name: "marea_read_project",
  description: "Read a contained project file.",
  execute: () => Promise.resolve("Synthetic project text."),
};

describe("controlled read-only runtime tools", () => {
  it("reads via the host without approval while built-in filesystem access stays denied", async () => {
    const execute = vi.fn((input: Readonly<Record<string, string>>) => {
      expect(input).toEqual({ path: "exercise.txt" });
      expect(Object.isFrozen(input)).toBe(true);
      return Promise.resolve("Verified project content.");
    });
    const model = new MareaFakeModel()
      .respondWithTools([
        { name: reader.name, id: "read:host", args: { path: "exercise.txt" } },
        { name: "read_file", id: "read:unsafe", args: { file_path: "/secret" } },
      ])
      .respond(new AIMessage("One exercise."));
    const runtime = createAgentRuntime({
      model: bindTestModel(model),
      checkpoint: createInMemoryCheckpointForTest(),
      approvalTool: unusedTool,
      systemPrompt: "Use the controlled reader.",
      readOnlyTools: [{ ...reader, execute }],
    });
    const events = await collect(
      runtime.streamMessage(
        {
          sessionId: "run:read",
          messageId: "message:read",
          text: "Inspect the project.",
        },
        signal(),
      ),
    );
    const toolCall = pairedToolCall(events);
    expect(events).toMatchObject([
      { type: "assistant-text-delta", text: "Use the controlled reader.-Inspect the project." },
      {
        arguments: { path: "exercise.txt" },
        callId: toolCall.started,
        name: "marea_read_project",
        type: "tool-started",
      },
      {
        callId: toolCall.finished,
        failed: false,
        result: "Verified project content.",
        type: "tool-finished",
      },
      { type: "assistant-text-delta", text: "One exercise." },
      { type: "turn-completed" },
    ]);
    expect(toolCall.started).toMatch(/^[0-9a-f-]{36}$/u);
    expect(execute).toHaveBeenCalledOnce();
    expect(model.boundToolNames.flat()).toContain(reader.name);
    const messages = model.calls[1]?.messages.filter((message) => ToolMessage.isInstance(message));
    expect(messages?.map((message) => message.content)).toEqual([
      "Verified project content.",
      "Error: permission denied for read on /secret",
    ]);
  });

  it("retains each explicit tool name and description", async () => {
    const reported: ToolLifecycleEvent[] = [];
    const tools = createReadOnlyTools([reader], "confirm_change", (event) => {
      reported.push(event);
    });
    const controlled = tools[0];
    expect(controlled?.name).toBe(reader.name);
    expect(controlled?.description).toBe(reader.description);
    expect(await controlled?.invoke({ path: "exercise.txt" })).toBe("Synthetic project text.");
    expect(
      createReadOnlyTools([], "confirm_change", (event) => {
        reported.push(event);
      }),
    ).toEqual([]);
    expect(
      createReadOnlyTools(
        [
          { ...reader, name: "marea_list_project" },
          { ...reader, name: "marea_read_skill" },
        ],
        "confirm_change",
        (event) => {
          reported.push(event);
        },
      ).map((entry) => entry.name),
    ).toEqual(["marea_list_project", "marea_read_skill"]);
  });

  it("rejects duplicate and approval-colliding names", () => {
    expect(() => createReadOnlyTools([reader, reader], "confirm_change", () => undefined)).toThrow(
      new AgentAdapterError("invalid-runtime-dependency", "Runtime tool names must be unique."),
    );
    try {
      createReadOnlyTools([reader], reader.name, () => undefined);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-runtime-dependency" });
    }
    expect(() => createReadOnlyTools([reader, reader], "confirm_change", () => undefined)).toThrow(
      "Runtime tool names must be unique.",
    );
    expect(() => createReadOnlyTools([reader], reader.name, () => undefined)).toThrow(
      "Runtime tool names must be unique.",
    );
  });

  it("cannot override a built-in or expose an unrecognized tool", () => {
    expect(() =>
      createReadOnlyTools(
        [
          // @ts-expect-error Invalid host input must not replace an upstream tool.
          { ...reader, name: "write_file" },
        ],
        "confirm_change",
        () => undefined,
      ),
    ).toThrow();
  });
});

it("lets the model recover from an expected read rejection without throwing or logging a stack", async () => {
  const model = new MareaFakeModel()
    .respondWithTools([
      { name: "marea_read_skill", id: "read:missing", args: { path: "resources" } },
    ])
    .respond(new AIMessage("I will use the already available skill instead."));
  const execute = vi.fn(() =>
    Promise.reject(new ReadOnlyToolInputError("Use a file from the frozen skill.")),
  );
  const runtime = createAgentRuntime({
    model: bindTestModel(model),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: unusedTool,
    systemPrompt: "Inspect safely.",
    readOnlyTools: [{ ...reader, name: "marea_read_skill", execute }],
  });
  const events = await collect(
    runtime.streamMessage(
      { sessionId: "run:recover-read", messageId: "message:recover-read", text: "Inspect." },
      signal(),
    ),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool-finished",
      failed: true,
      result: "Use a file from the frozen skill.",
    }),
  );
  expect(events).toContainEqual({ type: "turn-completed" });
  expect(
    model.calls[1]?.messages
      .filter((message) => ToolMessage.isInstance(message))
      .map((message) => message.content),
  ).toEqual(["Error: Use a file from the frozen skill."]);
});
it("does not disguise unexpected reader failures as correctable input", async () => {
  const error = new Error("Storage unavailable");
  const tools = createReadOnlyTools(
    [{ ...reader, execute: () => Promise.reject(error) }],
    "confirm_change",
    () => undefined,
  );
  await expect(tools[0]?.invoke({ path: "test" })).rejects.toBe(error);
});
it.each(["marea_search_project", "marea_glob_project"] as const)(
  "admits the host's guarded %s implementation",
  async (name) => {
    const events: ToolLifecycleEvent[] = [];
    const tools = createReadOnlyTools(
      [{ name, description: "Bounded search", execute: () => Promise.resolve("bounded result") }],
      "approval",
      (event) => events.push(event),
    );
    expect(await tools[0]?.invoke({ query: "*.ts" })).toBe("bounded result");
    expect(events).toMatchObject([
      { type: "tool-started", name, arguments: { query: "*.ts" } },
      { type: "tool-finished", result: "bounded result", failed: false },
    ]);
  },
);

it("rejects a reader colliding with the approved capability before constructing the tool", () => {
  expect(() => createReadOnlyTools([reader], reader.name, vi.fn())).toThrow(
    "Runtime tool names must be unique.",
  );
});
