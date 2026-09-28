import type { InferenceProviderRequest } from "@marea/plugin-api";

export interface OpenRouterHttpRequest {
  readonly apiKey: string;
  readonly body: InferenceProviderRequest;
  readonly endpoint: string;
  readonly signal: AbortSignal;
}

export interface OpenRouterHttpResponse {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: Headers;
  readonly ok: boolean;
  readonly status: number;
}

export interface OpenRouterHttpPort {
  send(request: OpenRouterHttpRequest): Promise<OpenRouterHttpResponse>;
}

interface OpenRouterDelta {
  readonly content?: string | null | undefined;
  readonly toolCalls?: readonly OpenRouterToolCallDelta[] | undefined;
}

export interface OpenRouterToolCallDelta {
  readonly arguments?: string | undefined;
  readonly id?: string | undefined;
  readonly index: number;
  readonly name?: string | undefined;
}

export interface OpenRouterChunk {
  readonly delta?: OpenRouterDelta | undefined;
  readonly finishReason?: string | null | undefined;
  readonly usage?: OpenRouterUsage | undefined;
}

interface OpenRouterUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
