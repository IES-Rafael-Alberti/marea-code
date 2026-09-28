import type { InferenceProvider, InferenceProviderError } from "@marea/plugin-api";
import type { ModelGatewayRequest, ModelGatewayStreamChunk } from "@marea/protocol";

export interface PrivateModelRoute {
  readonly provider: InferenceProvider;
  readonly upstreamModel: string;
}

export interface ModelGatewayClock {
  now(): string;
}

export interface ModelGatewayRetryScheduler {
  wait(error: InferenceProviderError, signal: AbortSignal): Promise<void>;
}

export interface ModelGateway {
  stream(request: ModelGatewayRequest, signal: AbortSignal): AsyncIterable<ModelGatewayStreamChunk>;
}
