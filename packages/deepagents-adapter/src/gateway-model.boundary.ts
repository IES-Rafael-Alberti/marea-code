import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import {
  CURRENT_PROTOCOL_VERSION,
  ModelGatewayMessageSchema,
  ModelGatewayRequestSchema,
  RequestIdSchema,
  type ModelGatewayMessage,
  type ModelGatewayRequest,
  type ModelGatewayStreamChunk,
  type RequestId,
} from "@marea/protocol";
import * as z from "zod";

import { ModelStreamError, type MareaGatewayModelOptions } from "./contracts.js";

interface GatewayCallOptions extends BaseChatModelCallOptions {
  readonly tools?: readonly BindToolsInput[];
}

const INTERNAL_WRITE_TOOL_NAME = "marea_write_file";
const PUBLIC_WRITE_TOOL_NAME = "write_file";

const toolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    args: z.record(z.string(), z.string()),
  })
  .readonly();

const openAiToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    parameters: z.json(),
  }),
});

export class MareaGatewayChatModel extends BaseChatModel<GatewayCallOptions> {
  readonly options: MareaGatewayModelOptions;

  constructor(options: MareaGatewayModelOptions) {
    super({});
    this.options = options;
  }

  _llmType(): string {
    return "marea-gateway";
  }

  override bindTools(
    tools: BindToolsInput[],
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, GatewayCallOptions> {
    return this.withConfig({ tools: Object.freeze([...tools]) });
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    let aggregate: ChatGenerationChunk | undefined;
    for await (const chunk of this._streamResponseChunks(messages, options)) {
      aggregate = aggregate === undefined ? chunk : aggregate.concat(chunk);
    }
    if (aggregate === undefined) {
      throw gatewayContractError();
    }
    return { generations: [aggregate] };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): AsyncGenerator<ChatGenerationChunk> {
    const signal = options.signal ?? new AbortController().signal;
    const requestId = RequestIdSchema.parse(this.options.nextRequestId());
    const request = createRequest(requestId, messages, options.tools ?? []);
    const state = new GatewayStreamState(requestId);

    for await (const chunk of this.options.gateway.stream(request, signal)) {
      state.accept(chunk);
      const generation = generationFor(chunk, state);
      if (generation !== null) {
        yield generation;
      }
    }
    state.assertCompleted();
  }
}

function createRequest(
  requestId: RequestId,
  messages: readonly BaseMessage[],
  tools: readonly BindToolsInput[],
): ModelGatewayRequest {
  return ModelGatewayRequestSchema.parse({
    kind: "model-gateway-request",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId,
    modelAlias: "marea",
    messages: translateMessages(messages),
    tools: translateTools(tools),
  });
}

function translateMessages(messages: readonly BaseMessage[]): readonly ModelGatewayMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((message) => translateMessage(message, toolNames));
}

function translateMessage(
  message: BaseMessage,
  toolNames: Map<string, string>,
): ModelGatewayMessage {
  if (SystemMessage.isInstance(message)) {
    return ModelGatewayMessageSchema.parse({ role: "system", content: message.text });
  }
  if (HumanMessage.isInstance(message)) {
    return ModelGatewayMessageSchema.parse({ role: "student", content: message.text });
  }
  if (AIMessage.isInstance(message)) {
    const toolCalls = (message.tool_calls ?? []).map((input) => {
      const parsed = parseToolCall(input);
      const publicName = toPublicToolName(parsed.name);
      toolNames.set(parsed.id, publicName);
      return { callId: parsed.id, tool: publicName, arguments: parsed.args };
    });
    return ModelGatewayMessageSchema.parse({
      role: "assistant",
      content: message.text,
      toolCalls,
    });
  }
  if (ToolMessage.isInstance(message)) {
    return ModelGatewayMessageSchema.parse({
      role: "tool",
      callId: message.tool_call_id,
      tool:
        message.name === undefined
          ? toolNames.get(message.tool_call_id)
          : toPublicToolName(message.name),
      content: message.text,
    });
  }
  throw gatewayContractError();
}

function parseToolCall(input: unknown): z.infer<typeof toolCallSchema> {
  return toolCallSchema.parse(input);
}

function translateTools(tools: readonly BindToolsInput[]) {
  const parsed = tools.map(parseTool);
  const controlled = new Set(
    parsed
      .filter((tool) => tool.name.startsWith("marea_"))
      .map((tool) => toPublicToolName(tool.name)),
  );
  return parsed
    .filter((tool) => !controlled.has(tool.name) || tool.name.startsWith("marea_"))
    .map((tool) => ({ ...tool, name: toPublicToolName(tool.name) }));
}

function parseTool(tool: BindToolsInput) {
  const parsed = openAiToolSchema.parse(convertToOpenAITool(tool));
  return {
    name: parsed.function.name,
    description: parsed.function.description,
    inputSchema: parsed.function.parameters,
  };
}

function generationFor(
  chunk: ModelGatewayStreamChunk,
  state: GatewayStreamState,
): ChatGenerationChunk | null {
  if (chunk.event === "text-delta") {
    return generation(new AIMessageChunk({ content: chunk.delta }), chunk.delta);
  }
  if (chunk.event === "tool-call") {
    return generation(
      new AIMessageChunk({
        content: "",
        tool_call_chunks: [
          {
            id: chunk.callId,
            name: toInternalToolName(chunk.tool),
            args: JSON.stringify(chunk.arguments),
            index: state.nextToolIndex(),
          },
        ],
      }),
      "",
    );
  }
  if (chunk.event === "completed") {
    return new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: "",
        response_metadata: {
          finish_reason: chunk.finishReason,
          usage: {
            input_tokens: chunk.usage.inputTokens,
            output_tokens: chunk.usage.outputTokens,
            total_tokens: chunk.usage.inputTokens + chunk.usage.outputTokens,
          },
        },
      }),
      text: "",
      generationInfo: {
        usage: {
          input_tokens: chunk.usage.inputTokens,
          output_tokens: chunk.usage.outputTokens,
          total_tokens: chunk.usage.inputTokens + chunk.usage.outputTokens,
        },
      },
    });
  }
  if (chunk.event === "failed") {
    throw new ModelStreamError({
      code: chunk.code,
      message: chunk.message,
      retryable: chunk.retryable,
    });
  }
  return null;
}

function toPublicToolName(name: string): string {
  if (name === "marea_edit_file") return "edit_file";
  if (name === "marea_execute") return "execute";
  if (name === "marea_delete") return "delete";
  return name === INTERNAL_WRITE_TOOL_NAME ? PUBLIC_WRITE_TOOL_NAME : name;
}

function toInternalToolName(name: string): string {
  if (name === "edit_file") return "marea_edit_file";
  if (name === "execute") return "marea_execute";
  if (name === "delete") return "marea_delete";
  return name === PUBLIC_WRITE_TOOL_NAME ? INTERNAL_WRITE_TOOL_NAME : name;
}

function generation(message: AIMessageChunk, text: string): ChatGenerationChunk {
  return new ChatGenerationChunk({ message, text });
}

class GatewayStreamState {
  readonly requestId: RequestId;
  private nextSequence = 0;
  // LangChain's v3 compatibility stream reserves content block 0 for string text.
  private toolIndex = 1;
  private started = false;
  private completed = false;

  constructor(requestId: RequestId) {
    this.requestId = requestId;
  }

  accept(chunk: ModelGatewayStreamChunk): void {
    if (
      chunk.requestId !== this.requestId ||
      chunk.sequence !== this.nextSequence ||
      this.completed
    ) {
      throw gatewayContractError();
    }
    this.nextSequence += 1;
    if (chunk.event === "started") {
      if (this.started) {
        throw gatewayContractError();
      }
      this.started = true;
      return;
    }
    if (!this.started) {
      throw gatewayContractError();
    }
    if (chunk.event === "completed") {
      this.completed = true;
    }
  }

  nextToolIndex(): number {
    const current = this.toolIndex;
    this.toolIndex += 1;
    return current;
  }

  assertCompleted(): void {
    if (!this.completed) {
      throw gatewayContractError();
    }
  }
}

function gatewayContractError(): Error {
  return new Error("The Marea gateway returned an unsupported model stream.");
}
