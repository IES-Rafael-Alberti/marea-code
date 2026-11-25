import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { requestIds, ScriptedGateway, textResponse } from "./gateway-model.fixture.js";
import { MareaGatewayChatModel } from "./gateway-model.boundary.js";

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
});
