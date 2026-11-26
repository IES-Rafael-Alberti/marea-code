import type { CanonicalRunEvent } from "@marea/protocol";

import type { StoredRun } from "./contracts.js";

/** Keeps only the first event of an undelivered envelope, still an exact prefix of the outbox. */
export function narrowStoredDelivery(run: StoredRun): StoredRun {
  // Stryker disable next-line ArrayDeclaration: a one-element stand-in is also left alone.
  const events = run.pendingDelivery?.events ?? [];
  const [first] = events;
  if (first === undefined || events.length === 1) return run;
  return { ...run, pendingDelivery: { events: [first] } };
}

/**
 * Removes the first undelivered event after the server refused it permanently. The server accepts
 * only `highest + 1`, so every later event moves down one sequence and the next sequence follows.
 * That is safe because nothing after a refused event reached the server: it rejects a whole
 * delivery or none of it. Event keys stay, so the same event is never created twice.
 */
export function setAsideFirstPending(run: StoredRun): {
  readonly run: StoredRun;
  readonly event: CanonicalRunEvent;
} {
  const [first, ...rest] = run.outbox;
  if (first === undefined) throw new Error("There is no pending event to set aside.");
  return {
    event: first.value,
    run: {
      ...run,
      nextSequence: run.nextSequence - 1,
      outbox: rest.map((stored) => ({
        ...stored,
        value: { ...stored.value, sequence: stored.value.sequence - 1 },
      })),
      pendingDelivery: null,
    },
  };
}
