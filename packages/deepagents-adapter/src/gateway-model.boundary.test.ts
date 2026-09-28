import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import { CURRENT_PROTOCOL_VERSION, ModelGatewayStreamChunkSchema } from "@marea/protocol";
import { tool } from "langchain";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  approvalReviewId,
  approvalTurn,
  assistantText,
  collect,
  approvedWriteEvents,
  signal,
} from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import {
  gatewayChunk as chunk,
  publicWriteResponse,
  requestIds,
  runtimeForGateway,
  ScriptedGateway,
  streamOf,
  textResponse,
  toolResponse,
} from "./gateway-model.fixture.js";
import { MareaGatewayChatModel } from "./gateway-model.boundary.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

describe("Marea gateway model boundary", () => {
  it("runs DeepAgents through only the owned gateway and public alias", async () => {
    const gateway = new ScriptedGateway(textResponse("hello"));
    const runtime = runtimeForGateway(gateway);

    await expect(
      collect(
        runtime.streamMessage(
          { messageId: "message:owned", sessionId: "owned-model", text: "hi" },
          signal(),
        ),
      ),
    ).resolves.toEqual([
      { type: "assistant-text-delta", text: "hello" },
      { type: "turn-completed" },
    ]);

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({
      kind: "model-gateway-request",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      modelAlias: "marea",
    });
    expect(gateway.requests[0]?.messages[0]?.content).toContain("Teach clearly.");
    expect(gateway.requests[0]?.messages[1]).toEqual({ role: "student", content: "hi" });
    expect(JSON.stringify(gateway.requests[0])).not.toMatch(/provider|apiKey|baseUrl/i);
  });

  it("preserves tools and complete assistant tool-call history", async () => {
    const gateway = new ScriptedGateway(
      toolResponse(),
      textResponse("done"),
      textResponse("continued"),
    );
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    const controlled = tool(({ path }) => Promise.resolve(`changed:${path}`), {
      name: "confirm_change",
      description: "Confirm a synthetic change",
      schema: z.object({ path: z.string() }),
    });
    const publicWrite = tool(() => Promise.resolve("denied by the adapter"), {
      name: "write_file",
      description: "The unprivileged public write tool.",
      schema: z.object({ path: z.string() }),
    });
    const bound = model.bindTools([controlled, publicWrite]);

    const first = await bound.invoke([
      new SystemMessage("Follow policy."),
      new HumanMessage("Change the file."),
    ]);
    expect(first.tool_calls).toEqual([
      {
        id: "call-1",
        name: "confirm_change",
        args: { path: "src/example.ts" },
        type: "tool_call",
      },
      {
        id: "call-2",
        name: "confirm_change",
        args: { path: "src/other.ts" },
        type: "tool_call",
      },
    ]);
    expect(first.content).toBe("");
    expect(first.text).toBe("");

    await bound.invoke([
      new SystemMessage("Follow policy."),
      new HumanMessage("Change the file."),
      new AIMessage({
        content: "I will ask first.",
        tool_calls: [
          {
            id: "call-1",
            name: "confirm_change",
            args: { path: "src/example.ts" },
            type: "tool_call",
          },
          {
            id: "call-2",
            name: "confirm_change",
            args: { path: "src/other.ts" },
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({
        content: "changed:src/example.ts",
        tool_call_id: "call-1",
      }),
      new ToolMessage({
        content: "changed:src/other.ts",
        name: "renamed_change",
        tool_call_id: "call-2",
      }),
    ]);
    const priorAnswer = new AIMessage("Prior answer.");
    Object.defineProperty(priorAnswer, "tool_calls", { value: undefined });
    await bound.invoke([
      new HumanMessage("Continue."),
      priorAnswer,
      new HumanMessage("Now answer."),
    ]);

    const translatedTool = gateway.requests[0]?.tools.find(
      (entry) => entry.name === "confirm_change",
    );
    expect(translatedTool?.description).toBe("Confirm a synthetic change");
    expect(translatedTool?.inputSchema).toMatchObject({ type: "object" });
    expect(gateway.requests[0]?.tools).toContainEqual(
      expect.objectContaining({
        name: "write_file",
        description: "The unprivileged public write tool.",
      }),
    );
    expect(gateway.requests[1]?.messages).toEqual([
      { role: "system", content: "Follow policy." },
      { role: "student", content: "Change the file." },
      {
        role: "assistant",
        content: "I will ask first.",
        toolCalls: [
          {
            callId: "call-1",
            tool: "confirm_change",
            arguments: { path: "src/example.ts" },
          },
          {
            callId: "call-2",
            tool: "confirm_change",
            arguments: { path: "src/other.ts" },
          },
        ],
      },
      {
        role: "tool",
        callId: "call-1",
        tool: "confirm_change",
        content: "changed:src/example.ts",
      },
      {
        role: "tool",
        callId: "call-2",
        tool: "renamed_change",
        content: "changed:src/other.ts",
      },
    ]);
    expect(gateway.requests[2]?.messages).toContainEqual({
      role: "assistant",
      content: "Prior answer.",
      toolCalls: [],
    });
  });

  it("maps the controlled write tool bidirectionally and hides the denied built-in collision", async () => {
    const gateway = new ScriptedGateway(publicWriteResponse(), textResponse("saved"));
    const execute = vi.fn(() => Promise.resolve("durable write result"));
    const checkpoint = createInMemoryCheckpointForTest();
    const runtime = createAgentRuntime({
      model: createMareaGatewayModel({ gateway, nextRequestId: requestIds() }),
      checkpoint,
      approvalTool: {
        name: "marea_write_file",
        description: "Write approved text content to a student file.",
        execute,
      },
      systemPrompt: "Teach clearly.",
    });

    const interrupted = await collect(
      runtime.streamMessage(
        { messageId: "message:public-write", sessionId: "public-write", text: "save notes" },
        signal(),
      ),
    );
    expect(interrupted.at(-1)).toMatchObject({
      type: "tool-approval-required",
      toolName: "marea_write_file",
      arguments: { path: "notes.txt", content: "hello" },
    });
    expect(execute).not.toHaveBeenCalled();
    const advertisedWrites = gateway.requests[0]?.tools.filter(
      (entry) => entry.name === "write_file",
    );
    expect(advertisedWrites).toEqual([
      expect.objectContaining({ description: "Write approved text content to a student file." }),
    ]);
    expect(gateway.requests[0]?.tools).not.toContainEqual(
      expect.objectContaining({ name: "marea_write_file" }),
    );

    const resumed = await collect(
      runtime.resumeApproval(
        {
          ...approvalTurn("public-write", "message:public-write", approvalReviewId(interrupted)),
          assistantText: assistantText(interrupted),
        },
        signal(),
      ),
    );
    expect(resumed).toMatchObject([
      ...approvedWriteEvents(resumed, "durable write result"),
      { type: "assistant-text-delta", text: "saved" },
      { type: "turn-completed" },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    const history = gateway.requests[1]?.messages;
    expect(history).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        toolCalls: [
          {
            callId: "write-1",
            tool: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        ],
      }),
    );
    expect(history).toContainEqual(
      expect.objectContaining({ role: "tool", callId: "write-1", tool: "write_file" }),
    );
  });

  it("preserves a tool call that follows streamed assistant text", async () => {
    const gateway = new ScriptedGateway((request) =>
      streamOf([
        chunk(request, 0, "started"),
        chunk(request, 1, "text-delta", { delta: "Preparing" }),
        chunk(request, 2, "tool-call", {
          callId: "write-after-text",
          tool: "write_file",
          arguments: { path: "notes.txt", content: "hello" },
        }),
        chunk(request, 3, "text-delta", { delta: " now" }),
        chunk(request, 4, "completed", {
          finishReason: "tool-call",
          usage: { inputTokens: 4, outputTokens: 2 },
        }),
      ]),
    );
    const runtime = createAgentRuntime({
      model: createMareaGatewayModel({ gateway, nextRequestId: requestIds() }),
      checkpoint: createInMemoryCheckpointForTest(),
      approvalTool: {
        name: "marea_write_file",
        description: "Write approved text content to a student file.",
        execute: vi.fn(() => Promise.resolve("unused")),
      },
      systemPrompt: "Teach clearly.",
    });

    await expect(
      collect(
        runtime.streamMessage(
          { messageId: "message:mixed", sessionId: "mixed-response", text: "save" },
          signal(),
        ),
      ),
    ).resolves.toEqual([
      { type: "assistant-text-delta", text: "Preparing" },
      { type: "assistant-text-delta", text: " now" },
      expect.objectContaining({
        type: "tool-approval-required",
        toolName: "marea_write_file",
      }),
    ]);
  });

  it("assigns stable indices to streamed tool calls", async () => {
    const gateway = new ScriptedGateway(toolResponse());
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    const indices: (number | undefined)[] = [];

    for await (const generation of model._streamResponseChunks(
      [new HumanMessage("Use tools.")],
      {},
    )) {
      const message = generation.message;
      if (!AIMessageChunk.isInstance(message)) {
        throw new Error("Expected an AI message chunk.");
      }
      for (const call of message.tool_call_chunks ?? []) {
        indices.push(call.index);
      }
      if ((message.tool_call_chunks?.length ?? 0) > 0) {
        expect(generation.text).toBe("");
        expect(message.content).toBe("");
        expect(message.text).toBe("");
      }
    }

    expect(indices).toEqual([1, 2]);
  });

  it("maps gateway usage and finish metadata onto the final message", async () => {
    const gateway = new ScriptedGateway(
      textResponse("answer", "length", 11, 3),
      textResponse("answer", "length", 11, 3),
    );
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    const controller = new AbortController();

    const invoked = await model.invoke([new HumanMessage("question")], {
      signal: controller.signal,
    });
    const generated = await model.generate([[new HumanMessage("question")]], {
      signal: controller.signal,
    });
    const result = generated.generations[0]?.[0];

    expect(model._llmType()).toBe("marea-gateway");
    expect(gateway.signals[0]).toBe(controller.signal);
    expect(gateway.signals[1]).toBe(controller.signal);
    expect(result?.text).toBe("answer");
    expect(invoked.response_metadata).toMatchObject({
      finish_reason: "length",
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        total_tokens: 14,
      },
    });
    expect(result?.generationInfo).toEqual({
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        total_tokens: 14,
      },
    });
  });

  it("rejects a stream with a gap or without completion", async () => {
    const gap = new ScriptedGateway((request) =>
      streamOf([
        chunk(request, 0, "started"),
        chunk(request, 2, "completed", {
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ]),
    );
    const incomplete = new ScriptedGateway((request) =>
      streamOf([
        chunk(request, 0, "started"),
        chunk(request, 1, "text-delta", { delta: "partial" }),
      ]),
    );

    await expect(
      new MareaGatewayChatModel({ gateway: gap, nextRequestId: requestIds() }).invoke([
        new HumanMessage("question"),
      ]),
    ).rejects.toThrow("unsupported model stream");
    await expect(
      new MareaGatewayChatModel({ gateway: incomplete, nextRequestId: requestIds() }).invoke([
        new HumanMessage("question"),
      ]),
    ).rejects.toThrow("unsupported model stream");
  });

  it("rejects invalid stream lifecycle and request correlation", async () => {
    const withoutStart = new ScriptedGateway((request) =>
      streamOf([
        chunk(request, 0, "text-delta", { delta: "early" }),
        chunk(request, 1, "completed", {
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ]),
    );
    const duplicateStart = new ScriptedGateway((request) =>
      streamOf([
        chunk(request, 0, "started"),
        chunk(request, 1, "started"),
        chunk(request, 2, "completed", {
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ]),
    );
    const afterCompletion = new ScriptedGateway((request) =>
      streamOf([
        chunk(request, 0, "started"),
        chunk(request, 1, "completed", {
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
        chunk(request, 2, "text-delta", { delta: "late" }),
      ]),
    );
    const wrongRequest = new ScriptedGateway((request) => {
      const started = chunk(request, 0, "started");
      return streamOf([
        ModelGatewayStreamChunkSchema.parse({
          ...started,
          requestId: "another-request",
        }),
        chunk(request, 1, "completed", {
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ]);
    });

    for (const gateway of [withoutStart, duplicateStart, afterCompletion, wrongRequest]) {
      await expect(
        new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() }).invoke([
          new HumanMessage("question"),
        ]),
      ).rejects.toStrictEqual(new Error("The Marea gateway returned an unsupported model stream."));
    }
  });

  it("rejects unsupported LangChain messages and an empty model generation", async () => {
    const gateway = new ScriptedGateway(textResponse("unused"));
    const model = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });

    await expect(model.invoke([new ChatMessage("content", "custom")])).rejects.toThrow(
      "unsupported model stream",
    );

    class EmptyStreamingModel extends MareaGatewayChatModel {
      override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
        await Promise.resolve();
        const chunks: ChatGenerationChunk[] = [];
        yield* chunks;
      }
    }
    await expect(
      new EmptyStreamingModel({ gateway, nextRequestId: requestIds() }).invoke([
        new HumanMessage("question"),
      ]),
    ).rejects.toThrow("unsupported model stream");
  });
});
