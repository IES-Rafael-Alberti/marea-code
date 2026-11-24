import type { ModelGatewayRequest } from "@marea/protocol";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { collect, signal, unusedTool } from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import { ReadOnlyToolInputError, type ReadOnlyTool } from "./contracts.js";
import {
  gatewayChunk,
  requestIds,
  ScriptedGateway,
  streamOf,
  textResponse,
  type GatewayScript,
} from "./gateway-model.fixture.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

function toolCalls(
  ...calls: readonly { readonly tool: string; readonly arguments: Record<string, string> }[]
): GatewayScript {
  return (request) =>
    streamOf([
      gatewayChunk(request, 0, "started"),
      ...calls.map((call, index) =>
        gatewayChunk(request, index + 1, "tool-call", { callId: `call-${String(index)}`, ...call }),
      ),
      gatewayChunk(request, calls.length + 1, "completed", {
        finishReason: "tool-call",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ]);
}

function run(readers: readonly ReadOnlyTool[], ...scripts: GatewayScript[]) {
  const gateway = new ScriptedGateway(...scripts);
  const runtime = createAgentRuntime({
    model: createMareaGatewayModel({ gateway, nextRequestId: requestIds() }),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: unusedTool,
    systemPrompt: "Synthetic tutor.",
    readOnlyTools: readers,
  });
  return {
    gateway,
    events: collect(
      runtime.streamMessage(
        { sessionId: "run:tools", messageId: "message:tools", text: "Help me." },
        signal(),
      ),
    ),
  };
}

function toolResults(request: ModelGatewayRequest | undefined) {
  return (request?.messages ?? []).filter((message) => message.role === "tool");
}

const search: ReadOnlyTool = {
  name: "marea_search_project",
  description: "Search project text.",
  execute: (input) =>
    input.path === "/missing"
      ? Promise.reject(new ReadOnlyToolInputError("The workspace entry does not exist. (/missing)"))
      : Promise.resolve("src/main.ts:1: match"),
};

describe("tool failures the model can correct", () => {
  it("answers an unknown tool with the public names it was offered and completes the turn", async () => {
    const { gateway, events } = run(
      [search],
      toolCalls({ tool: "unknown_tool", arguments: {} }),
      textResponse("I will search instead."),
    );
    expect((await events).at(-1)).toEqual({ type: "turn-completed" });
    const [result] = toolResults(gateway.requests[1]);
    expect(result?.content).toBe(
      "Error: unknown_tool is not an available tool. Use one of: confirm_change, marea_search_project.",
    );
  });

  it("returns invalid reader input as an error result instead of failing the turn", async () => {
    const strict: ReadOnlyTool = {
      ...search,
      execute: (input) =>
        Promise.resolve(z.object({ query: z.string() }).strict().parse(input).query),
    };
    const { gateway, events } = run(
      [strict],
      toolCalls({ tool: "marea_search_project", arguments: { pattern: "x" } }),
      textResponse("Retrying with query."),
    );
    expect((await events).at(-1)).toEqual({ type: "turn-completed" });
    expect(toolResults(gateway.requests[1])[0]?.content).toMatch(/^Error: invalid arguments \(/u);
  });

  it("completes two parallel searches when one names a path that does not exist", async () => {
    const { gateway, events } = run(
      [search],
      toolCalls(
        { tool: "marea_search_project", arguments: { query: "main" } },
        { tool: "marea_search_project", arguments: { query: "main", path: "/missing" } },
      ),
      textResponse("Only src has matches."),
    );
    const observed = await events;
    expect(observed.at(-1)).toEqual({ type: "turn-completed" });
    expect(toolResults(gateway.requests[1]).map((message) => message.content)).toEqual([
      "src/main.ts:1: match",
      "Error: The workspace entry does not exist. (/missing)",
    ]);
  });
});
