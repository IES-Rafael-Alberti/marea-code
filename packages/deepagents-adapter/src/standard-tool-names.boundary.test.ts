import { describe, expect, it, vi } from "vitest";

import { collect, signal, unusedTool } from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import type { ReadOnlyTool } from "./contracts.js";
import {
  gatewayChunk,
  requestIds,
  ScriptedGateway,
  streamOf,
  textResponse,
  type GatewayScript,
} from "./gateway-model.fixture.js";
import {
  toInternalArguments,
  toPublicArguments,
  toPublicInputSchema,
} from "./tool-parameters.boundary.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

const readers = (execute: ReadOnlyTool["execute"]): ReadOnlyTool[] =>
  (
    [
      "marea_read_project",
      "marea_list_project",
      "marea_glob_project",
      "marea_search_project",
    ] as const
  ).map((name) => ({ name, description: "Synthetic reader.", execute }));

function call(tool: string, args: Record<string, string>): GatewayScript {
  return (request) =>
    streamOf([
      gatewayChunk(request, 0, "started"),
      gatewayChunk(request, 1, "tool-call", { callId: "call-1", tool, arguments: args }),
      gatewayChunk(request, 2, "completed", {
        finishReason: "tool-call",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ]);
}

function run(execute: ReadOnlyTool["execute"], ...scripts: GatewayScript[]) {
  const gateway = new ScriptedGateway(...scripts);
  const runtime = createAgentRuntime({
    model: createMareaGatewayModel({ gateway, nextRequestId: requestIds() }),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: unusedTool,
    systemPrompt: "Synthetic tutor.",
    readOnlyTools: readers(execute),
  });
  return {
    gateway,
    events: collect(
      runtime.streamMessage(
        { sessionId: "run:names", messageId: "message:names", text: "Explore." },
        signal(),
      ),
    ),
  };
}

describe("standard tool names and parameters", () => {
  it("offers Marea's readers once, under DeepAgents names, with named text parameters", async () => {
    const { gateway, events } = run(() => Promise.resolve("ok"), textResponse("hi"));
    await events;
    const tools = gateway.requests[0]?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      "confirm_change",
      "read_file",
      "ls",
      "glob",
      "grep",
    ]);
    expect(JSON.stringify(tools)).not.toMatch(/marea_\w+_project/u);
    expect(tools.find((tool) => tool.name === "grep")?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        pattern: { type: "string", description: expect.stringContaining("Literal text") as string },
        path: { type: "string" },
      },
      required: ["pattern"],
    });
    expect(tools.find((tool) => tool.name === "read_file")?.inputSchema).toMatchObject({
      properties: { file_path: { type: "string" }, offset: { type: "string" } },
      required: ["file_path"],
    });
  });

  it.each([
    [{ pattern: "main" }, { query: "main" }],
    [
      { query: "main", path: "/src" },
      { query: "main", path: "/src" },
    ],
  ])("runs Marea's search for grep %j and passes %j", async (args, expected) => {
    const execute = vi.fn(() => Promise.resolve("src/main.ts:1: main"));
    const { gateway, events } = run(execute, call("grep", args), textResponse("Found it."));
    expect((await events).at(-1)).toEqual({ type: "turn-completed" });
    expect(execute).toHaveBeenCalledWith(expected);
    const replayed = gateway.requests[1]?.messages.find((message) => message.role === "assistant");
    expect(replayed).toMatchObject({
      toolCalls: [
        {
          tool: "grep",
          arguments: { pattern: "main", ...("path" in args ? { path: "/src" } : {}) },
        },
      ],
    });
  });

  it("still runs a call that uses an old internal name from an earlier session", async () => {
    const execute = vi.fn(() => Promise.resolve("a.ts"));
    const { events } = run(
      execute,
      call("marea_glob_project", { query: "*.ts" }),
      textResponse("Found."),
    );
    expect((await events).at(-1)).toEqual({ type: "turn-completed" });
    expect(execute).toHaveBeenCalledWith({ query: "*.ts" });
  });

  it("answers task and other unavailable tools with the offered names", async () => {
    const { gateway, events } = run(
      () => Promise.resolve("ok"),
      call("task", { description: "explore" }),
      textResponse("I will search myself."),
    );
    expect((await events).at(-1)).toEqual({ type: "turn-completed" });
    expect(gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content:
        "Error: task is not an available tool. Use one of: confirm_change, read_file, ls, glob, grep.",
    });
  });
});

describe("parameter renaming", () => {
  it("keeps arguments of undescribed tools and lets a named argument win over its synonym", () => {
    expect(toInternalArguments("confirm_change", { path: "a" })).toEqual({ path: "a" });
    expect(toPublicArguments("marea_execute", { command: "dir" })).toEqual({ command: "dir" });
    expect(toInternalArguments("marea_read_project", { file_path: "/a", path: "/b" })).toEqual({
      path: "/b",
    });
    expect(toInternalArguments("marea_read_project", { path: "/b", file_path: "/a" })).toEqual({
      path: "/b",
    });
    expect(toPublicArguments("marea_write_file", { path: "a", content: "x" })).toEqual({
      file_path: "a",
      content: "x",
    });
  });

  it("renames schema properties and required names, leaving other schema shapes alone", () => {
    expect(
      toPublicInputSchema("marea_search_project", {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query", 3],
      }),
    ).toEqual({
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern", 3],
    });
    expect(toPublicInputSchema("marea_search_project", { type: "object" })).toEqual({
      type: "object",
    });
    expect(toPublicInputSchema("marea_search_project", { properties: null })).toEqual({
      properties: null,
    });
  });
});
