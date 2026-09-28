import type { InferenceCancellation } from "@marea/plugin-api";

export function cancellationFor(signal: AbortSignal): InferenceCancellation {
  return Object.freeze({
    get aborted(): boolean {
      return signal.aborted;
    },
    subscribe(listener: () => void): () => void {
      signal.addEventListener("abort", listener, { once: true });
      return () => {
        signal.removeEventListener("abort", listener);
      };
    },
  });
}
