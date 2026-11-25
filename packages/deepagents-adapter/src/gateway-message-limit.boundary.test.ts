import { HumanMessage } from "@langchain/core/messages";
import { ModelGatewayRequestSchema } from "@marea/protocol";
import { expect, it } from "vitest";

import { requestIds, ScriptedGateway, textResponse } from "./gateway-model.fixture.js";
import { GATEWAY_MESSAGE_LIMIT, MareaGatewayChatModel } from "./gateway-model.boundary.js";

const conversation = (count: number) =>
  Array.from({ length: count }, (_, index) => new HumanMessage(`synthetic ${String(index)}`));

it("refuses a request over the gateway message limit with a typed failure", async () => {
  const gateway = new ScriptedGateway(textResponse("ok"));
  const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });

  await expect(model.invoke(conversation(GATEWAY_MESSAGE_LIMIT + 1))).rejects.toMatchObject({
    name: "ModelStreamError",
    streamCode: "context-exceeded",
    streamRetryable: false,
    streamMessage:
      "The conversation has more messages than the model gateway accepts in one request. Start a new session to continue. Nothing was truncated.",
  });
  expect(gateway.requests).toHaveLength(0);
});

it("mirrors the wire contract's message limit exactly", async () => {
  const gateway = new ScriptedGateway(textResponse("ok"));
  const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });

  await model.invoke(conversation(GATEWAY_MESSAGE_LIMIT));

  const request = gateway.requests[0];
  expect(request?.messages).toHaveLength(GATEWAY_MESSAGE_LIMIT);
  expect(
    ModelGatewayRequestSchema.safeParse({
      ...request,
      messages: [...(request?.messages ?? []), { role: "student", content: "one more" }],
    }).success,
  ).toBe(false);
});
