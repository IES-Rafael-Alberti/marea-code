import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  gatewayChunk,
  requestIds,
  ScriptedGateway,
  streamOf,
  textResponse,
} from "./gateway-model.fixture.js";
import { MareaGatewayChatModel } from "./gateway-model.boundary.js";

const searchCall = () =>
  new AIMessage({
    content: "",
    tool_calls: [{ id: "call-1", name: "grep", args: { pattern: "x" }, type: "tool_call" }],
  });

describe("tolerant tool-call history", () => {
  it("replays non-text tool arguments as text instead of rejecting the history", async () => {
    const gateway = new ScriptedGateway(textResponse("continued"));
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    await model.invoke([
      new HumanMessage("Search."),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "grep",
            args: {
              pattern: "x",
              offset: 20,
              recursive: true,
              paths: ["a"],
              none: null,
              gone: undefined,
            },
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({ content: "no matches", tool_call_id: "call-1" }),
      new HumanMessage("Continue."),
    ]);
    expect(gateway.requests[0]?.messages[1]).toStrictEqual({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          callId: "call-1",
          tool: "grep",
          arguments: { pattern: "x", offset: "20", recursive: "true", paths: '["a"]' },
        },
      ],
    });
  });

  it("drops empty assistant messages and keeps tool calls paired", async () => {
    const gateway = new ScriptedGateway(textResponse("continued"));
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    await model.invoke([
      new HumanMessage("Hello."),
      new AIMessage({ content: "" }),
      new HumanMessage("Hello again."),
      searchCall(),
      new ToolMessage({ content: "found", tool_call_id: "call-1" }),
    ]);
    expect(gateway.requests[0]?.messages.map((message) => message.role)).toEqual([
      "student",
      "student",
      "assistant",
      "tool",
    ]);
  });

  it("drops an assistant message whose tool calls are missing altogether", async () => {
    const gateway = new ScriptedGateway(textResponse("continued"));
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    const broken = Object.assign(new AIMessage({ content: "" }), { tool_calls: undefined });
    await model.invoke([new HumanMessage("Hello."), broken, new HumanMessage("Again.")]);
    expect(gateway.requests[0]?.messages.map((message) => message.role)).toEqual([
      "student",
      "student",
    ]);
  });

  it("gives an empty tool result a placeholder instead of an empty message", async () => {
    const gateway = new ScriptedGateway(textResponse("continued"));
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    await model.invoke([
      new HumanMessage("Search."),
      searchCall(),
      new ToolMessage({ content: "", tool_call_id: "call-1" }),
    ]);
    expect(gateway.requests[0]?.messages[2]).toStrictEqual({
      role: "tool",
      callId: "call-1",
      tool: "grep",
      content: "The tool returned no content.",
    });
  });
});

describe("empty model response", () => {
  it("fails as a retryable empty response instead of completing the turn", async () => {
    const gateway = new ScriptedGateway((request) =>
      streamOf([
        gatewayChunk(request, 0, "started"),
        gatewayChunk(request, 1, "completed", {
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 0 },
        }),
      ]),
    );
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    await expect(model.invoke([new HumanMessage("Hi.")])).rejects.toMatchObject({
      streamCode: "empty-response",
      streamRetryable: true,
      streamMessage: "The model finished without any text or tool call.",
    });
  });
});
