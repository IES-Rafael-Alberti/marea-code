import { STARTUP_MESSAGE_ID, type OpenRunResponse } from "@marea/protocol";

import type { Clock, IdSource, StoredRun } from "./contracts.js";

export function prepareStoredStartup(run: StoredRun, response: OpenRunResponse): StoredRun {
  if (response.snapshot.agentMode !== "tutoring" || response.snapshot.startup === undefined)
    return run;
  const progress = response.startupState;
  if (progress === undefined) throw new Error("The server omitted durable tutor startup progress.");
  const existing = run.turns.find((turn) => turn.messageId === STARTUP_MESSAGE_ID);
  if (existing !== undefined) {
    if (existing.kind !== "startup") throw new Error("The tutor startup identity is reserved.");
    if ((progress === "completed" || progress === "cancelled") && existing.state !== progress) {
      throw new Error("Local tutor startup disagrees with the server's completed state.");
    }
    return run;
  }
  if (progress === "started")
    throw new Error("Tutor startup cannot resume without its durable local checkpoint.");
  return {
    ...run,
    turns: [
      ...run.turns,
      {
        kind: "startup",
        messageId: STARTUP_MESSAGE_ID,
        state: progress === "pending" ? "started" : progress,
      },
    ],
  };
}

export function recordStartupProgress(
  run: StoredRun,
  state: "started" | "completed" | "cancelled",
  ids: IdSource,
  clock: Clock,
): StoredRun {
  const key = `startup:${state}`;
  if (run.eventKeys.includes(key)) return run;
  return {
    ...run,
    eventKeys: [...run.eventKeys, key],
    nextSequence: run.nextSequence + 1,
    outbox: [
      ...run.outbox,
      {
        key,
        value: {
          eventType: "tutor-startup",
          state,
          eventId: ids.event(),
          sequence: run.nextSequence,
          occurredAt: clock.now(),
        },
      },
    ],
  };
}
