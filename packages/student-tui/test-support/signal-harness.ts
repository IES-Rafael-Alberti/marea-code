import { vi, type Mock } from "vitest";

import type { SignalSource, SupportedSignal } from "../src/contracts.js";

export interface SignalHarness {
  readonly handlers: Map<SupportedSignal, () => void>;
  readonly removals: Map<SupportedSignal, Mock<() => void>>;
  readonly source: SignalSource;
}

export function createSignalHarness(): SignalHarness {
  const handlers = new Map<SupportedSignal, () => void>();
  const removals = new Map<SupportedSignal, Mock<() => void>>();
  return {
    handlers,
    removals,
    source: {
      subscribe(signal, handler): () => void {
        handlers.set(signal, handler);
        const remove = vi.fn<() => void>();
        removals.set(signal, remove);
        return remove;
      },
    },
  };
}
