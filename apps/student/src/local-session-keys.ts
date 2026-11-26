import * as z from "zod";

import type { StoredEvent, StoredRun } from "./contracts.js";
import { turnEndedKey } from "./turn-keys.js";

/** Events whose key only guards one delivery; once delivered nothing can repeat them. */
const OBSERVATIONAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "assistant-progress",
  "model-diagnostic",
  "tool-started",
  "tool-finished",
  "turn-diagnostic",
]);
const RECENT_PROJECT_CHANGE_KEYS = 16;
const OwnedKeySchema = z.tuple([z.string()], z.string());

/** Message a deduplication key belongs to, or null for run-level keys. */
function keyOwner(key: string): string | null {
  if (key.startsWith("student:")) return key.slice("student:".length);
  if (key.startsWith("assistant:")) return key.slice("assistant:".length);
  try {
    return OwnedKeySchema.parse(JSON.parse(key))[0];
  } catch {
    return null;
  }
}

function isRunLevelKey(key: string): boolean {
  return key === "project-context" || key.startsWith("startup:");
}

/**
 * Drops deduplication keys that can no longer matter, so a long session never exhausts the
 * bounded state. A key stays while its event is still undelivered, while its turn is open, and
 * for the run-level events that must never repeat.
 */
export function pruneEventKeys(run: StoredRun, delivered: readonly StoredEvent[] = []): StoredRun {
  const queued = new Set(
    // Stryker disable next-line ArrayDeclaration: a placeholder without a key adds nothing to the queue.
    [...run.outbox, ...(run.pendingDelivery?.events ?? [])].map((event) => event.key),
  );
  const open = new Set(
    run.turns.filter((turn) => turn.state === "started").map((turn) => turn.messageId),
  );
  const observed = new Set(
    delivered
      .filter((event) => OBSERVATIONAL_EVENT_TYPES.has(event.value.eventType))
      .map((event) => event.key),
  );
  const terminal = new Set(run.turns.map((turn) => turnEndedKey(turn.messageId)));
  const recentChanges = new Set(
    run.eventKeys
      .filter((key) => key.startsWith("project-change:"))
      .slice(-RECENT_PROJECT_CHANGE_KEYS),
  );
  const keep = (key: string): boolean => {
    if (queued.has(key) || terminal.has(key) || isRunLevelKey(key) || recentChanges.has(key))
      return true;
    if (observed.has(key)) return false;
    const owner = keyOwner(key);
    return owner === null ? open.size > 0 : open.has(owner);
  };
  const eventKeys = run.eventKeys.filter(keep);
  return eventKeys.length === run.eventKeys.length ? run : { ...run, eventKeys };
}

/** Removes delivered events and the keys they no longer need. */
export function acknowledgeStored(run: StoredRun, highestDurableSequence: number): StoredRun {
  const events = run.pendingDelivery?.events.filter(
    (event) => event.value.sequence > highestDurableSequence,
  );
  return pruneEventKeys(
    {
      ...run,
      outbox: run.outbox.filter((event) => event.value.sequence > highestDurableSequence),
      pendingDelivery: events === undefined || events.length === 0 ? null : { events },
    },
    // Events that stay queued remain protected by the queue check, so every former event can be
    // offered as delivered.
    run.outbox,
  );
}
