import type { InferenceProviderError } from "@marea/plugin-api";

import type { ModelGatewayRetryScheduler } from "../../model-gateway/contracts.js";

/**
 * Waits before a retryable provider attempt: the provider's requested delay when present,
 * otherwise the configured delay, never longer than the configured maximum.
 */
export function createRetryScheduler(options: {
  readonly delayMs: number;
  readonly maxDelayMs: number;
}): ModelGatewayRetryScheduler {
  return Object.freeze({
    wait(error: InferenceProviderError, signal: AbortSignal): Promise<void> {
      const delay = Math.min(error.retryAfterMs ?? options.delayMs, options.maxDelayMs);
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason as Error);
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason as Error);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        signal.addEventListener("abort", onAbort);
      });
    },
  });
}
