import {
  CURRENT_PROTOCOL_VERSION,
  ModelGatewayStreamChunkSchema,
  RequestIdSchema,
  type ModelGatewayRequest,
  type ModelGatewayStreamChunk,
  type RequestId,
} from "@marea/protocol";

import { unusedTool } from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import type { MareaModelGateway } from "./contracts.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

export type GatewayScript = (
  request: ModelGatewayRequest,
  signal: AbortSignal,
) => AsyncIterable<ModelGatewayStreamChunk>;

export class ScriptedGateway implements MareaModelGateway {
  readonly requests: ModelGatewayRequest[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly scripts: GatewayScript[];

  constructor(...scripts: GatewayScript[]) {
    this.scripts = scripts;
  }

  stream(
    request: ModelGatewayRequest,
    streamSignal: AbortSignal,
  ): AsyncIterable<ModelGatewayStreamChunk> {
    this.requests.push(request);
    this.signals.push(streamSignal);
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error("No synthetic gateway response remains.");
    }
    return script(request, streamSignal);
  }
}

export function requestIds(): () => RequestId {
  let counter = 0;
  return () => RequestIdSchema.parse(`request-${String(++counter)}`);
}

export function runtimeForGateway(gateway: ScriptedGateway) {
  return createAgentRuntime({
    model: createMareaGatewayModel({ gateway, nextRequestId: requestIds() }),
    checkpoint: createInMemoryCheckpointForTest(),
    approvalTool: unusedTool,
    systemPrompt: "Teach clearly.",
  });
}

export function textResponse(
  text: string,
  finishReason: "stop" | "tool-call" | "length" = "stop",
  inputTokens = 2,
  outputTokens = 1,
): GatewayScript {
  return (request) =>
    streamOf([
      gatewayChunk(request, 0, "started"),
      gatewayChunk(request, 1, "text-delta", { delta: text }),
      gatewayChunk(request, 2, "completed", {
        finishReason,
        usage: { inputTokens, outputTokens },
      }),
    ]);
}

export function toolResponse(): GatewayScript {
  return (request) =>
    streamOf([
      gatewayChunk(request, 0, "started"),
      gatewayChunk(request, 1, "tool-call", {
        callId: "call-1",
        tool: "confirm_change",
        arguments: { path: "src/example.ts" },
      }),
      gatewayChunk(request, 2, "tool-call", {
        callId: "call-2",
        tool: "confirm_change",
        arguments: { path: "src/other.ts" },
      }),
      gatewayChunk(request, 3, "completed", {
        finishReason: "tool-call",
        usage: { inputTokens: 4, outputTokens: 2 },
      }),
    ]);
}

export function publicWriteResponse(): GatewayScript {
  return (request) =>
    streamOf([
      gatewayChunk(request, 0, "started"),
      gatewayChunk(request, 1, "tool-call", {
        callId: "write-1",
        tool: "write_file",
        arguments: { path: "notes.txt", content: "hello" },
      }),
      gatewayChunk(request, 2, "completed", {
        finishReason: "tool-call",
        usage: { inputTokens: 4, outputTokens: 1 },
      }),
    ]);
}

export function partialWriteFailureResponse(): GatewayScript {
  return (request) =>
    streamOf([
      gatewayChunk(request, 0, "started"),
      gatewayChunk(request, 1, "tool-call", {
        callId: "uncommitted-write",
        tool: "write_file",
        arguments: { path: "unsafe.txt", content: "never approved" },
      }),
      gatewayChunk(request, 2, "failed", {
        code: "upstream-overloaded",
        message: "private diagnostic",
        retryable: true,
      }),
    ]);
}

export function partialTextFailureResponse(text = "partial"): GatewayScript {
  return (request) =>
    streamOf([
      gatewayChunk(request, 0, "started"),
      gatewayChunk(request, 1, "text-delta", { delta: text }),
      gatewayChunk(request, 2, "failed", {
        code: "upstream-overloaded",
        message: "private diagnostic",
        retryable: true,
      }),
    ]);
}

export function failedResponse(): GatewayScript {
  return (request) =>
    streamOf([
      gatewayChunk(request, 0, "started"),
      gatewayChunk(request, 1, "failed", {
        code: "upstream-overloaded",
        message: "private diagnostic",
        retryable: true,
      }),
    ]);
}

export async function* streamOf(
  chunks: readonly ModelGatewayStreamChunk[],
): AsyncGenerator<ModelGatewayStreamChunk> {
  await Promise.resolve();
  yield* chunks;
}

export function gatewayChunk(
  request: ModelGatewayRequest,
  sequence: number,
  event: ModelGatewayStreamChunk["event"],
  fields: Readonly<Record<string, string | boolean | object>> = {},
): ModelGatewayStreamChunk {
  return ModelGatewayStreamChunkSchema.parse({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: request.requestId,
    modelAlias: "marea",
    sequence,
    emittedAt: "2026-09-03T10:00:00.000Z",
    event,
    ...fields,
  });
}
