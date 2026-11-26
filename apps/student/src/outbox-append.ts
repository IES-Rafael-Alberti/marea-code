import type { CanonicalRunEvent } from "@marea/protocol";

import type { StoredRun } from "./contracts.js";

/** Queues one event under a deduplication key unless that key was already recorded. */
export function appendKeyedEvent(
  run: StoredRun,
  key: string,
  build: (sequence: number) => CanonicalRunEvent,
): StoredRun {
  if (run.eventKeys.includes(key)) return run;
  return {
    ...run,
    eventKeys: [...run.eventKeys, key],
    nextSequence: run.nextSequence + 1,
    outbox: [...run.outbox, { key, value: build(run.nextSequence) }],
  };
}
