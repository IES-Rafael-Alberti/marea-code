import {
  InferenceProviderError,
  type InferenceCancellation,
  type InferenceProvider,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "@marea/plugin-api";

import { InferenceFailure } from "./inference-failure.boundary.js";
import { cancellationFor } from "./inference-cancellation.js";

function aborted(): InferenceProviderError {
  return new InferenceProviderError({
    code: "aborted",
    message: "The inference request was cancelled.",
    retryable: false,
  });
}

function assertNotAborted(cancellation: Pick<InferenceCancellation, "aborted">): void {
  if (cancellation.aborted) throw aborted();
}

function assertRunning(signal: AbortSignal, failure: Error): void {
  if (signal.aborted) throw failure;
}

export async function* streamWithinDeadline(
  provider: InferenceProvider,
  request: InferenceProviderRequest,
  cancellation: InferenceCancellation,
  durationMs: number | null,
): AsyncGenerator<InferenceProviderEvent> {
  assertNotAborted(cancellation);
  const controller = new AbortController();
  const stopped = Promise.withResolvers<never>();
  // A timeout may occur while the consumer is suspended at a yield.
  void stopped.promise.catch(() => undefined);
  let failure: Error = aborted();
  const stop = () => {
    clearTimeout(timer);
    controller.abort();
    stopped.reject(failure);
  };
  const timer =
    durationMs === null
      ? undefined
      : setTimeout(() => {
          failure = new InferenceFailure(
            "deadline-exceeded",
            "The configured inference duration limit was reached.",
          );
          stop();
        }, durationMs);
  let unsubscribe: () => void = () => undefined;
  let iterator: AsyncIterator<InferenceProviderEvent> | undefined;
  try {
    unsubscribe = cancellation.subscribe(stop);
    if (cancellation.aborted) stop();
    assertNotAborted(controller.signal);
    iterator = provider.stream(request, cancellationFor(controller.signal))[Symbol.asyncIterator]();
    while (!controller.signal.aborted) {
      const result = await Promise.race([iterator.next(), stopped.promise]);
      assertRunning(controller.signal, failure);
      if (result.done) return;
      yield result.value;
    }
    throw failure;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    controller.abort();
    // An uncooperative iterator may never settle its pending next; cancellation
    // still bounds the caller. Observe cleanup rejection without waiting forever.
    void iterator?.return?.().catch(() => undefined);
  }
}
