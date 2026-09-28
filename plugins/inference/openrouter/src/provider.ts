import type {
  InferenceCancellation,
  InferenceFinishReason,
  InferenceProvider,
  InferenceProviderEvent,
  InferenceProviderRequest,
} from "@marea/plugin-api";
import { InferenceProviderError } from "@marea/plugin-api";

import type { OpenRouterHttpPort, OpenRouterHttpResponse } from "./contracts.js";
import type { OpenRouterConfiguration } from "./configuration.js";
import { parseOpenRouterData } from "./openrouter-http.boundary.js";
import { readSseData } from "./sse.boundary.js";
import { ToolCallAccumulator } from "./tool-calls.boundary.js";

function providerError(
  code: InferenceProviderError["code"],
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): InferenceProviderError {
  return new InferenceProviderError({
    code,
    message,
    retryable,
    // Stryker disable next-line ConditionalExpression: the error exposes undefined in both cases.
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function retryAfterMilliseconds(headers: Headers): number | undefined {
  // Stryker disable next-line StringLiteral: every nonnumeric fallback yields no retry delay.
  const value = headers.get("retry-after") ?? "";
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds * 1_000 : undefined;
}

function httpError(response: OpenRouterHttpResponse): InferenceProviderError {
  if (response.status === 401 || response.status === 403) {
    return providerError(
      "authentication-failed",
      "The inference provider rejected its server credential.",
      false,
    );
  }
  if (response.status === 429) {
    return providerError(
      "rate-limited",
      "The inference provider rate limit was reached.",
      true,
      retryAfterMilliseconds(response.headers),
    );
  }
  return response.status >= 500
    ? providerError("unavailable", "The inference provider is unavailable.", true)
    : providerError("invalid-response", "The inference provider rejected the request.", false);
}

function finishReason(value: string | null | undefined): InferenceFinishReason | undefined {
  if (value == null) {
    return undefined;
  }
  if (value === "tool_calls") {
    return "tool-call";
  }
  if (value === "stop" || value === "length") {
    return value;
  }
  throw providerError(
    "invalid-response",
    "The inference provider returned an unsupported finish reason.",
    false,
  );
}

async function* translateStream(
  response: OpenRouterHttpResponse,
): AsyncIterable<InferenceProviderEvent> {
  if (response.body === null) {
    throw providerError(
      "invalid-response",
      "The inference provider returned no stream body.",
      false,
    );
  }
  const calls = new ToolCallAccumulator();
  let completed = false;
  let reason: InferenceFinishReason | undefined;
  let usage: InferenceProviderEvent | undefined;
  for await (const data of readSseData(response.body)) {
    if (data === "[DONE]") {
      completed = true;
      break;
    }
    const chunk = parseOpenRouterData(data);
    const text = chunk.delta?.content;
    if (text !== undefined && text !== null && text.length > 0) {
      yield Object.freeze({ text, type: "text-delta" });
    }
    if (chunk.delta?.toolCalls !== undefined) {
      calls.add(chunk.delta.toolCalls);
    }
    reason = finishReason(chunk.finishReason) ?? reason;
    if (chunk.usage !== undefined) {
      usage = Object.freeze({ ...chunk.usage, type: "usage" });
    }
  }
  if (!completed)
    throw providerError("unavailable", "The inference provider stream was interrupted.", true);
  if (reason === undefined) {
    throw providerError(
      "invalid-response",
      "The inference provider stream ended before completion.",
      false,
    );
  }
  for (const event of calls.finish()) {
    yield event;
  }
  if (usage !== undefined) {
    yield usage;
  }
  yield Object.freeze({ finishReason: reason, type: "completed" });
}

function aborted(): InferenceProviderError {
  return providerError("aborted", "The inference request was cancelled.", false);
}

export function createOpenRouterProviderWith(
  configuration: OpenRouterConfiguration,
  http: OpenRouterHttpPort,
): InferenceProvider {
  return Object.freeze({
    async *stream(
      request: InferenceProviderRequest,
      cancellation: InferenceCancellation,
    ): AsyncIterable<InferenceProviderEvent> {
      if (cancellation.aborted) {
        throw aborted();
      }
      const controller = new AbortController();
      const unsubscribe = cancellation.subscribe(() => {
        controller.abort();
      });
      try {
        let response: OpenRouterHttpResponse;
        try {
          response = await http.send({
            apiKey: configuration.apiKey,
            body: request,
            endpoint: configuration.endpoint,
            signal: controller.signal,
          });
        } catch {
          throw controller.signal.aborted
            ? aborted()
            : providerError("unavailable", "The inference provider is unavailable.", true);
        }
        if (!response.ok) {
          throw httpError(response);
        }
        try {
          yield* translateStream(response);
        } catch (error) {
          if (controller.signal.aborted) throw aborted();
          if (error instanceof InferenceProviderError) throw error;
          throw providerError(
            "unavailable",
            "The inference provider stream was interrupted.",
            true,
          );
        }
      } finally {
        unsubscribe();
      }
    },
  });
}
