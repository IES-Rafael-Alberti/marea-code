import { describe, expect, it } from "vitest";

import {
  ModelGatewayMessageSchema,
  ModelGatewayRequestSchema,
  ModelGatewayStreamChunkSchema,
} from "./model-gateway.js";

const textMessage = { role: "student", content: "Help me reason about this." } as const;
const request = {
  kind: "model-gateway-request",
  protocolVersion: "0.1",
  requestId: "request-model-1",
  modelAlias: "marea",
  messages: [textMessage],
  tools: [
    {
      name: "write_file",
      description: "Write approved content inside the project workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
} as const;

const chunkBase = {
  protocolVersion: "0.1",
  requestId: "request-model-1",
  modelAlias: "marea",
  sequence: 0,
  emittedAt: "2026-09-03T10:00:00Z",
} as const;

describe("Marea model gateway protocol", () => {
  it.each(["system", "student"])("accepts text message role %s", (role) => {
    expect(ModelGatewayMessageSchema.parse({ role, content: "Bounded content" }).role).toBe(role);
  });

  it("preserves assistant tool-call history without provider metadata", () => {
    expect(
      ModelGatewayMessageSchema.parse({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            callId: "tool-call-1",
            tool: "write_file",
            arguments: { path: "src/index.ts", content: "export {};" },
          },
          {
            callId: "tool-call-2",
            tool: "write_file",
            arguments: { path: "src/second.ts", content: "export {};" },
          },
        ],
      }),
    ).toMatchObject({ role: "assistant", content: "" });
    expect(
      ModelGatewayMessageSchema.parse({
        role: "assistant",
        content: "A text response.",
        toolCalls: [],
      }).content,
    ).toBe("A text response.");
  });

  it("rejects empty or ambiguous assistant tool history", () => {
    const call = {
      callId: "tool-call-1",
      tool: "write_file",
      arguments: { path: "src/index.ts" },
    } as const;
    expect(() =>
      ModelGatewayMessageSchema.parse({ role: "assistant", content: "", toolCalls: [] }),
    ).toThrow("An assistant message must contain text or a tool call.");
    expect(() =>
      ModelGatewayMessageSchema.parse({
        role: "assistant",
        content: "",
        toolCalls: [call, call],
      }),
    ).toThrow("Assistant tool call identifiers must be unique.");
    expect(() =>
      ModelGatewayMessageSchema.parse({
        role: "assistant",
        content: "",
        toolCalls: [{ ...call, arguments: { path: 3 } }],
      }),
    ).toThrow();
  });

  it("accepts tool results without provider metadata", () => {
    const message = ModelGatewayMessageSchema.parse({
      role: "tool",
      callId: "tool-call-1",
      tool: "write_file",
      content: "Created src/index.ts",
    });

    expect(message.role).toBe("tool");
  });

  it("parses a bounded request whose only model identity is marea", () => {
    const parsed = ModelGatewayRequestSchema.parse(request);

    expect(parsed.modelAlias).toBe("marea");
    expect(parsed.tools[0]?.inputSchema).toEqual(request.tools[0].inputSchema);
    expect(Object.isFrozen(parsed.messages)).toBe(true);
  });

  it.each(["provider", "upstreamModel", "apiKey", "baseUrl"])(
    "rejects private request field %s",
    (field) => {
      expect(() => ModelGatewayRequestSchema.parse({ ...request, [field]: "private" })).toThrow();
    },
  );

  it("rejects private fields in nested messages and tools", () => {
    expect(() =>
      ModelGatewayRequestSchema.parse({
        ...request,
        messages: [{ ...textMessage, provider: "private" }],
      }),
    ).toThrow();
    expect(() =>
      ModelGatewayRequestSchema.parse({
        ...request,
        tools: [{ ...request.tools[0], providerOptions: { secret: true } }],
      }),
    ).toThrow();
  });

  it("requires the public model alias", () => {
    expect(() =>
      ModelGatewayRequestSchema.parse({ ...request, modelAlias: "provider/real-model" }),
    ).toThrow();
  });

  it("bounds message content and request history", () => {
    expect(
      ModelGatewayMessageSchema.parse({ ...textMessage, content: "a".repeat(65_536) }).role,
    ).toBe("student");
    expect(() => ModelGatewayMessageSchema.parse({ ...textMessage, content: "" })).toThrow();
    expect(() =>
      ModelGatewayMessageSchema.parse({ ...textMessage, content: "a".repeat(65_537) }),
    ).toThrow();

    const maximum = Array.from({ length: 256 }, () => textMessage);
    expect(
      ModelGatewayRequestSchema.parse({ ...request, messages: maximum }).messages,
    ).toHaveLength(256);
    expect(() => ModelGatewayRequestSchema.parse({ ...request, messages: [] })).toThrow();
    expect(() =>
      ModelGatewayRequestSchema.parse({ ...request, messages: [...maximum, textMessage] }),
    ).toThrow();
  });

  it("bounds and deduplicates tool definitions", () => {
    const boundedTool = {
      name: "tool_0",
      description: "a".repeat(2_048),
      inputSchema: true,
    } as const;
    const maximum = Array.from({ length: 64 }, (_, index) => ({
      ...boundedTool,
      name: `tool_${String(index)}`,
    }));

    expect(ModelGatewayRequestSchema.parse({ ...request, tools: maximum }).tools).toHaveLength(64);
    expect(() =>
      ModelGatewayRequestSchema.parse({ ...request, tools: [...maximum, { ...boundedTool }] }),
    ).toThrow();
    expect(() =>
      ModelGatewayRequestSchema.parse({ ...request, tools: [boundedTool, boundedTool] }),
    ).toThrow("Model tool names must be unique.");
    expect(() =>
      ModelGatewayRequestSchema.parse({
        ...request,
        tools: [{ ...boundedTool, description: "" }],
      }),
    ).toThrow();
    expect(() =>
      ModelGatewayRequestSchema.parse({
        ...request,
        tools: [{ ...boundedTool, description: "a".repeat(2_049) }],
      }),
    ).toThrow();
  });

  it("parses every stream event discriminant", () => {
    const chunks = [
      { ...chunkBase, event: "started" },
      { ...chunkBase, sequence: 1, event: "text-delta", delta: "Hello" },
      {
        ...chunkBase,
        sequence: 2,
        event: "tool-call",
        callId: "tool-call-1",
        tool: "write_file",
        arguments: { path: "src/index.ts", content: "export {};" },
      },
      {
        ...chunkBase,
        sequence: 3,
        event: "completed",
        finishReason: "tool-call",
        usage: { inputTokens: 20, outputTokens: 10 },
      },
      {
        ...chunkBase,
        sequence: 4,
        event: "failed",
        code: "upstream-unavailable",
        message: "Inference is temporarily unavailable.",
        retryable: true,
      },
    ];

    expect(chunks.map((chunk) => ModelGatewayStreamChunkSchema.parse(chunk).event)).toEqual([
      "started",
      "text-delta",
      "tool-call",
      "completed",
      "failed",
    ]);
  });

  it.each(["stop", "tool-call", "length"])("accepts finish reason %s", (finishReason) => {
    expect(
      ModelGatewayStreamChunkSchema.parse({
        ...chunkBase,
        event: "completed",
        finishReason,
        usage: { inputTokens: 0, outputTokens: 0 },
      }).event,
    ).toBe("completed");
  });

  it("bounds stream sequences, token usage, and deltas", () => {
    const completed = {
      ...chunkBase,
      sequence: Number.MAX_SAFE_INTEGER,
      event: "completed",
      finishReason: "stop",
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
    } as const;

    expect(ModelGatewayStreamChunkSchema.parse(completed).sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => ModelGatewayStreamChunkSchema.parse({ ...completed, sequence: -1 })).toThrow();
    expect(() =>
      ModelGatewayStreamChunkSchema.parse({
        ...completed,
        usage: { ...completed.usage, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow();
    expect(
      ModelGatewayStreamChunkSchema.parse({
        ...chunkBase,
        event: "text-delta",
        delta: "a".repeat(16_384),
      }).event,
    ).toBe("text-delta");
    expect(() =>
      ModelGatewayStreamChunkSchema.parse({ ...chunkBase, event: "text-delta", delta: "" }),
    ).toThrow();
    expect(() =>
      ModelGatewayStreamChunkSchema.parse({
        ...chunkBase,
        event: "text-delta",
        delta: "a".repeat(16_385),
      }),
    ).toThrow();
  });

  it("bounds sanitized gateway failures", () => {
    const failure = {
      ...chunkBase,
      event: "failed",
      code: "a".repeat(64),
      message: "a".repeat(1_024),
      retryable: false,
    } as const;

    expect(ModelGatewayStreamChunkSchema.parse(failure).event).toBe("failed");
    expect(() => ModelGatewayStreamChunkSchema.parse({ ...failure, code: "" })).toThrow();
    expect(() =>
      ModelGatewayStreamChunkSchema.parse({ ...failure, code: "A_PRIVATE_CODE" }),
    ).toThrow();
    expect(() => ModelGatewayStreamChunkSchema.parse({ ...failure, code: "1valid" })).toThrow();
    expect(() => ModelGatewayStreamChunkSchema.parse({ ...failure, code: "valid!" })).toThrow();
    expect(() =>
      ModelGatewayStreamChunkSchema.parse({ ...failure, code: "a".repeat(65) }),
    ).toThrow();
    expect(() => ModelGatewayStreamChunkSchema.parse({ ...failure, message: "" })).toThrow();
    expect(() =>
      ModelGatewayStreamChunkSchema.parse({ ...failure, message: "a".repeat(1_025) }),
    ).toThrow();
  });

  it("rejects private stream fields and non-JSON tool arguments", () => {
    expect(() =>
      ModelGatewayStreamChunkSchema.parse({
        ...chunkBase,
        event: "started",
        upstreamModel: "private",
      }),
    ).toThrow();
    expect(() =>
      ModelGatewayStreamChunkSchema.parse({
        ...chunkBase,
        event: "tool-call",
        callId: "tool-call-1",
        tool: "write_file",
        arguments: undefined,
      }),
    ).toThrow();
  });
});
