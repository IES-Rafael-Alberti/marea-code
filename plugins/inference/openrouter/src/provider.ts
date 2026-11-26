import type { AdmittedRequest } from "./context-preflight.js";
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

/** Reasons that end a response without being a normal completion; handled after usage. */
type AbnormalFinish = "content_filter" | "error";

/** Shown in place of an answer the provider's filter blocked; the turn still completes. */
const CONTENT_FILTER_NOTICE =
  "El proveedor del modelo ha bloqueado esta respuesta con su filtro de contenido. Reformula tu mensaje e inténtalo de nuevo.";

function finishReason(
  value: string | null | undefined,
): InferenceFinishReason | AbnormalFinish | undefined {
  if (value == null) {
    return undefined;
  }
  if (value === "tool_calls") {
    return "tool-call";
  }
  if (value === "stop" || value === "length" || value === "content_filter" || value === "error") {
    return value;
  }
  throw providerError(
    "invalid-response",
    "The inference provider returned an unsupported finish reason.",
    false,
  );
}

/** A response the provider cut short: an error is retried; a filtered one ends with a notice. */
function* abnormalCompletion(
  reason: AbnormalFinish,
  streamedText: boolean,
): Generator<InferenceProviderEvent> {
  if (reason === "error") {
    throw providerError(
      "unavailable",
      "The inference provider reported an error while answering.",
      true,
    );
  }
  // Calls cut off by the filter are dropped: the student cannot review half a request.
  yield Object.freeze({
    text: `${streamedText ? "\n\n" : ""}${CONTENT_FILTER_NOTICE}`,
    type: "text-delta",
  });
  yield Object.freeze({ finishReason: "stop", type: "completed" });
}

async function* translateStream(
  response: OpenRouterHttpResponse,
  requestId: string,
  contextWindowTokens: number | undefined,
): AsyncIterable<InferenceProviderEvent> {
  if (response.body === null) {
    throw providerError(
      "invalid-response",
      "The inference provider returned no stream body.",
      false,
    );
  }
  const calls = new ToolCallAccumulator(requestId);
  let completed = false;
  let reason: InferenceFinishReason | AbnormalFinish | undefined;
  let streamedText = false;
  let usage: InferenceProviderEvent | undefined;
  for await (const data of readSseData(response.body)) {
    if (data === "[DONE]") {
      completed = true;
      break;
    }
    const chunk = parseOpenRouterData(data);
    const text = chunk.delta?.content;
    if (text !== undefined && text !== null && text.length > 0) {
      streamedText = true;
      yield Object.freeze({ text, type: "text-delta" });
    }
    if (chunk.delta?.toolCalls !== undefined) {
      calls.add(chunk.delta.toolCalls);
    }
    reason = finishReason(chunk.finishReason) ?? reason;
    if (chunk.usage !== undefined) {
      usage = Object.freeze({
        ...chunk.usage,
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        type: "usage",
      });
    }
  }
  if (!completed)
    throw providerError("unavailable", "The inference provider stream was interrupted.", true);
  // Usage first: what the provider charged is accounted for even if a later step fails.
  if (usage !== undefined) {
    yield usage;
  }
  if (reason === undefined) {
    throw providerError(
      "invalid-response",
      "The inference provider stream ended before completion.",
      false,
    );
  }
  if (reason === "error" || reason === "content_filter") {
    yield* abnormalCompletion(reason, streamedText);
    return;
  }
  for (const event of calls.finish()) {
    yield event;
  }
  yield Object.freeze({ finishReason: reason, type: "completed" });
}

function aborted(): InferenceProviderError {
  return providerError("aborted", "The inference request was cancelled.", false);
}

export function createOpenRouterProviderWith(
  configuration: OpenRouterConfiguration,
  http: OpenRouterHttpPort,
  preflight?: (request: InferenceProviderRequest, signal: AbortSignal) => Promise<AdmittedRequest>,
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
        const admitted: AdmittedRequest =
          preflight === undefined ? request : await preflight(request, controller.signal);
        let response: OpenRouterHttpResponse;
        try {
          response = await http.send({
            apiKey: configuration.apiKey,
            body: admitted,
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
          yield* translateStream(response, admitted.requestId, admitted.contextWindowTokens);
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
