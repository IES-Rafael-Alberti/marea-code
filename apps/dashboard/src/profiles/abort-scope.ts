/** Combine request and module cancellation without requiring Safari 17.4's AbortSignal.any. */
export function abortScope(signals: readonly AbortSignal[]) {
  const controller = new AbortController();
  const listeners: (() => void)[] = [];
  const dispose = () => {
    for (const remove of listeners) remove();
    listeners.length = 0;
  };
  for (const source of signals) {
    const abort = () => {
      controller.abort(source.reason);
      dispose();
    };
    if (source.aborted) {
      abort();
      break;
    }
    source.addEventListener("abort", abort, { once: true });
    listeners.push(() => {
      source.removeEventListener("abort", abort);
    });
  }
  return { signal: controller.signal, dispose };
}
