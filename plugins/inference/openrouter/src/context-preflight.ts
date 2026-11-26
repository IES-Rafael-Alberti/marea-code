import {
  InferenceProviderError,
  type InferenceProviderRequest,
  type ProviderModel,
} from "@marea/plugin-api";

/** Conservative admission, not token counting: one UTF-8 byte per token plus framing.
 * Never truncate messages. Reserve output explicitly, including on unlimited budget routes.
 */
const DEFAULT_OUTPUT_TOKENS = 8192;
/** An admitted request, with the capacity of the model it was admitted for. */
export type AdmittedRequest = InferenceProviderRequest & { readonly contextWindowTokens?: number };

export function createContextPreflight(
  models: (signal: AbortSignal) => Promise<readonly ProviderModel[]>,
  now: () => number = Date.now,
): (request: InferenceProviderRequest, signal: AbortSignal) => Promise<AdmittedRequest> {
  let catalog: readonly ProviderModel[] | undefined;
  let expiresAt = 0;
  return async (request, signal) => {
    signal.throwIfAborted();
    if (catalog === undefined || now() >= expiresAt) {
      try {
        catalog = await models(signal);
      } catch {
        throw new InferenceProviderError({
          code: "context-unavailable",
          message: "The model context capacity could not be verified. Retry before continuing.",
          retryable: true,
        });
      }
      expiresAt = now() + 300_000;
    }
    const model = catalog.find((model) => model.id === request.upstreamModel);
    if (model?.contextWindowTokens === undefined) {
      throw new InferenceProviderError({
        code: "context-unavailable",
        message:
          "The model context capacity could not be verified. Retry or ask your teacher to select a model with a known context capacity.",
        retryable: true,
      });
    }
    const capacity = model.contextWindowTokens;
    const requested = request.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const output =
      request.preferModelMaxOutput === true
        ? (model.maxOutputTokens ?? requested)
        : Math.min(requested, model.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS);
    const input =
      new TextEncoder().encode(JSON.stringify({ messages: request.messages, tools: request.tools }))
        .byteLength + 4096;
    // Up to the default, the whole reservation must fit as before. Room asked beyond it is a
    // preference that shrinks to the space left, so a larger request never refuses more input.
    if (input + Math.min(output, DEFAULT_OUTPUT_TOKENS) > capacity) {
      throw new InferenceProviderError({
        code: "context-exceeded",
        message:
          "The complete session exceeds the conservative context budget. Ask your teacher to reduce the materials or select a model with a larger context, then start a new session. Nothing was truncated or summarized.",
        retryable: false,
      });
    }
    signal.throwIfAborted();
    return {
      ...request,
      maxOutputTokens: Math.min(output, capacity - input),
      contextWindowTokens: capacity,
    };
  };
}
