import { describe, expect, it } from "vitest";

import {
  CONTEXT_WINDOW_CAPABILITY,
  ModelGatewayRequestSchema,
  ModelGatewayStreamChunkSchema,
} from "./model-gateway.js";

const request = {
  kind: "model-gateway-request",
  protocolVersion: "0.1",
  requestId: "request-model-1",
  modelAlias: "marea",
  messages: [{ role: "student", content: "Help." }],
  tools: [],
} as const;

const completed = (usage: object) =>
  ModelGatewayStreamChunkSchema.safeParse({
    protocolVersion: "0.1",
    requestId: "request-model-1",
    modelAlias: "marea",
    sequence: 2,
    emittedAt: "2026-09-03T10:00:00Z",
    event: "completed",
    finishReason: "stop",
    usage,
  }).success;

describe("model context window", () => {
  it("is offered behind its own capability and asked for only with true", () => {
    expect(CONTEXT_WINDOW_CAPABILITY).toBe("marea.models.context-window");
    expect(ModelGatewayRequestSchema.safeParse({ ...request, contextWindow: true }).success).toBe(
      true,
    );
    expect(ModelGatewayRequestSchema.safeParse({ ...request, contextWindow: false }).success).toBe(
      false,
    );
  });

  it("travels as an optional positive token count of the completion", () => {
    expect(completed({ inputTokens: 1, outputTokens: 1 })).toBe(true);
    expect(completed({ inputTokens: 1, outputTokens: 1, contextWindowTokens: 1 })).toBe(true);
    expect(completed({ inputTokens: 1, outputTokens: 1, contextWindowTokens: 0 })).toBe(false);
    expect(completed({ inputTokens: 1, outputTokens: 1, contextWindowTokens: 1.5 })).toBe(false);
  });
});
