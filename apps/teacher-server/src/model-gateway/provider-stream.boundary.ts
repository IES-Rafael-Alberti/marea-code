import {
  InferenceProviderError,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "@marea/plugin-api";

import type { ModelGatewayRetryScheduler, PrivateModelRoute } from "./contracts.js";
import { inferenceFailure } from "./inference-failure.boundary.js";
import { cancellationFor } from "./inference-cancellation.js";

/** The first attempt and up to two automatic retries. */
const MAX_ATTEMPTS = 3;

export interface ProviderFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type ProviderStreamResult =
  | { readonly type: "event"; readonly event: InferenceProviderEvent }
  | { readonly type: "failure"; readonly failure: ProviderFailure };

function failureFor(error: unknown): ProviderFailure {
  const failure = inferenceFailure(error);
  return { code: failure.code, message: failure.message, retryable: failure.retryable };
}

/**
 * Retry only while the student has seen nothing of this response: transient provider failures,
 * and a response the provider sent in a shape Marea could not read, which a fresh one may fix.
 */
function canRetry(
  error: unknown,
  emitted: boolean,
  attempt: number,
): error is InferenceProviderError {
  return (
    !emitted &&
    error instanceof InferenceProviderError &&
    (error.retryable || error.code === "invalid-response") &&
    attempt < MAX_ATTEMPTS
  );
}

export async function* providerStream(
  request: InferenceProviderRequest,
  route: PrivateModelRoute,
  retry: ModelGatewayRetryScheduler,
  signal: AbortSignal,
): AsyncIterable<ProviderStreamResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let emitted = false;
    try {
      for await (const event of route.provider.stream(request, cancellationFor(signal))) {
        // Usage is accounting, not output: a response that failed after it can still be retried.
        if (event.type !== "usage") emitted = true;
        yield { event, type: "event" };
      }
      return;
    } catch (error: unknown) {
      if (!canRetry(error, emitted, attempt)) {
        yield { failure: failureFor(error), type: "failure" };
        return;
      }
      try {
        await retry.wait(error, signal);
      } catch (retryError: unknown) {
        yield { failure: { ...failureFor(retryError), retryable: false }, type: "failure" };
        return;
      }
    }
  }
}
