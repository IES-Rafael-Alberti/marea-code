import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { expect, it } from "vitest";
import * as z from "zod";
import { MareaGatewayChatModel } from "./gateway-model.boundary.js";
import {
  ScriptedGateway,
  gatewayChunk as chunk,
  streamOf,
  textResponse,
  requestIds,
} from "./gateway-model.fixture.js";
it.each(["edit_file", "execute", "delete"])(
  "routes %s exclusively through the reviewed tool and preserves its public history name",
  async (name) => {
    const internal = `marea_${name}`;
    const gateway = new ScriptedGateway(
      (request) =>
        streamOf([
          chunk(request, 0, "started"),
          chunk(request, 1, "tool-call", {
            callId: "call:reviewed",
            tool: name,
            arguments: { path: "main.ts" },
          }),
          chunk(request, 2, "completed", {
            finishReason: "tool-call",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        ]),
      textResponse("done"),
    );
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    const controlled = tool(() => Promise.resolve("recorded"), {
      name: internal,
      description: "Reviewed capability",
      schema: z.object({ path: z.string() }),
    });
    const builtin = tool(() => Promise.resolve("denied"), {
      name,
      description: "Unprivileged builtin",
      schema: z.object({ path: z.string() }),
    });
    const bound = model.bindTools([builtin, controlled]);
    const response = await bound.invoke([new HumanMessage("Act")]);
    expect(gateway.requests[0]?.tools).toMatchObject([
      { name, description: "Reviewed capability" },
    ]);
    expect(gateway.requests[0]?.tools).toHaveLength(1);
    expect(response.tool_calls).toMatchObject([
      { name: internal, id: "call:reviewed", args: { path: "main.ts" } },
    ]);
    await bound.invoke([
      new HumanMessage("Act"),
      response,
      new ToolMessage({ name: internal, tool_call_id: "call:reviewed", content: "recorded" }),
    ]);
    expect(gateway.requests[1]?.messages).toContainEqual({
      role: "tool",
      tool: name,
      callId: "call:reviewed",
      content: "recorded",
    });
    expect(gateway.requests[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        toolCalls: [{ tool: name, callId: "call:reviewed", arguments: { path: "main.ts" } }],
      }),
    );
  },
);

it("keeps controlled readers whose names have no public alias", async () => {
  const gateway = new ScriptedGateway(textResponse("read"));
  const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
  const reader = tool(() => Promise.resolve("contents"), {
    name: "marea_read_project",
    description: "Controlled reader",
    schema: z.object({ path: z.string() }),
  });
  await model.bindTools([reader]).invoke([new HumanMessage("Read")]);
  expect(gateway.requests[0]?.tools).toMatchObject([
    { name: "marea_read_project", description: "Controlled reader" },
  ]);
  expect(gateway.requests[0]?.tools).toHaveLength(1);
});
