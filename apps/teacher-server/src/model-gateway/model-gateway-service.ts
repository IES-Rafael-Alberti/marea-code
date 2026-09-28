import {
  type InferenceMessage,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "@marea/plugin-api";
import {
  ModelGatewayStreamChunkSchema,
  type ModelGatewayMessage,
  type ModelGatewayRequest,
  type ModelGatewayStreamChunk,
} from "@marea/protocol";

import type {
  ModelGateway,
  ModelGatewayClock,
  ModelGatewayRetryScheduler,
  PrivateModelRoute,
} from "./contracts.js";
import { providerStream, type ProviderFailure } from "./provider-stream.boundary.js";

export interface ModelGatewayServiceOptions {
  readonly clock: ModelGatewayClock;
  readonly retry: ModelGatewayRetryScheduler;
  readonly route: PrivateModelRoute;
}

function inferenceMessage(message: ModelGatewayMessage): InferenceMessage {
  switch (message.role) {
    case "student":
      return { content: message.content, role: "user" };
    case "system":
      return { content: message.content, role: "system" };
    case "assistant":
      return {
        content: message.content,
        role: "assistant",
        toolCalls: message.toolCalls.map((call) => ({
          arguments: call.arguments,
          callId: call.callId,
          name: call.tool,
        })),
      };
    case "tool":
      return {
        content: message.content,
        role: "tool",
        toolCallId: message.callId,
      };
  }
}

function providerRequest(
  request: ModelGatewayRequest,
  route: PrivateModelRoute,
): InferenceProviderRequest {
  return Object.freeze({
    messages: request.messages.map(inferenceMessage),
    requestId: request.requestId,
    tools: request.tools.map((tool) => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name,
    })),
    upstreamModel: route.upstreamModel,
  });
}

interface StreamState {
  readonly sequence: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

function eventChunk(
  request: ModelGatewayRequest,
  clock: ModelGatewayClock,
  sequence: number,
  event: Exclude<InferenceProviderEvent, { readonly type: "completed" }>,
  state: StreamState,
): { readonly chunk: ModelGatewayStreamChunk | null; readonly state: StreamState } {
  const base = {
    emittedAt: clock.now(),
    modelAlias: request.modelAlias,
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    sequence,
  };
  if (event.type === "usage") {
    return {
      chunk: null,
      state: {
        ...state,
        usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens },
      },
    };
  }
  if (event.type === "text-delta") {
    return {
      chunk: ModelGatewayStreamChunkSchema.parse({
        ...base,
        event: "text-delta",
        delta: event.text,
      }),
      state: { ...state, sequence: sequence + 1 },
    };
  }
  return {
    chunk: ModelGatewayStreamChunkSchema.parse({
      ...base,
      event: "tool-call",
      arguments: event.arguments,
      callId: event.callId,
      tool: event.name,
    }),
    state: { ...state, sequence: sequence + 1 },
  };
}

function failedChunk(
  request: ModelGatewayRequest,
  clock: ModelGatewayClock,
  sequence: number,
  failure: ProviderFailure,
): ModelGatewayStreamChunk {
  return ModelGatewayStreamChunkSchema.parse({
    code: failure.code,
    emittedAt: clock.now(),
    event: "failed",
    message: failure.message,
    modelAlias: request.modelAlias,
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    retryable: failure.retryable,
    sequence,
  });
}

export class ModelGatewayService implements ModelGateway {
  readonly #options: ModelGatewayServiceOptions;

  public constructor(options: ModelGatewayServiceOptions) {
    this.#options = options;
  }

  public async *stream(
    request: ModelGatewayRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelGatewayStreamChunk> {
    let state: StreamState = {
      sequence: 1,
      usage: null,
    };
    yield ModelGatewayStreamChunkSchema.parse({
      emittedAt: this.#options.clock.now(),
      event: "started",
      modelAlias: request.modelAlias,
      protocolVersion: request.protocolVersion,
      requestId: request.requestId,
      sequence: 0,
    });
    for await (const result of providerStream(
      providerRequest(request, this.#options.route),
      this.#options.route,
      this.#options.retry,
      signal,
    )) {
      if (result.type === "failure") {
        yield failedChunk(request, this.#options.clock, state.sequence, result.failure);
        return;
      }
      const event = result.event;
      if (event.type === "completed") {
        if (state.usage === null) {
          yield failedChunk(request, this.#options.clock, state.sequence, {
            code: "inference-failed",
            message: "The inference request failed.",
            retryable: false,
          });
          return;
        }
        yield ModelGatewayStreamChunkSchema.parse({
          emittedAt: this.#options.clock.now(),
          event: "completed",
          finishReason: event.finishReason,
          modelAlias: request.modelAlias,
          protocolVersion: request.protocolVersion,
          requestId: request.requestId,
          sequence: state.sequence,
          usage: state.usage,
        });
        return;
      }
      const translated = eventChunk(request, this.#options.clock, state.sequence, event, state);
      state = translated.state;
      if (translated.chunk !== null) yield translated.chunk;
    }
    yield failedChunk(request, this.#options.clock, state.sequence, {
      code: "inference-failed",
      message: "The inference request failed.",
      retryable: false,
    });
  }
}
