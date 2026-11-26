import { vi } from "vitest";
import type { SessionsClient } from "./sessions-client.boundary.js";
import { RunHistoryResponseSchema, ClassSessionsResponseSchema } from "@marea/protocol";
import {
  evaluationClientFixture,
  HISTORY,
  SESSIONS as LEGACY_SESSIONS,
  NOW,
  NO_REVIEW,
} from "../evaluation/evaluation.fixture.js";
import { SessionsController } from "./sessions-controller.js";
import type { NoticeClient } from "./notice-client.boundary.js";
export const SESSIONS = ClassSessionsResponseSchema.parse({
  ...LEGACY_SESSIONS,
  kind: "class-sessions-response",
  runs: LEGACY_SESSIONS.runs.map((run) => ({ ...run, classId: "class:one", review: NO_REVIEW })),
});
export const notices: NoticeClient = { publish: vi.fn(), query: vi.fn() };
export const owned: SessionsController[] = [];
export function disposeControllers(): void {
  for (const controller of owned.splice(0)) controller.dispose();
  vi.useRealTimers();
}
export function setup() {
  const client = {
    ...evaluationClientFixture(),
    classes: vi.fn<SessionsClient["classes"]>().mockResolvedValue(SESSIONS),
  };
  const changed = vi.fn();
  const controller = new SessionsController(client, notices, changed);
  owned.push(controller);
  return { client, changed, controller };
}
export function page(runId: string, after = 0, through = after + 1, more = false) {
  return RunHistoryResponseSchema.parse({
    ...HISTORY,
    runId,
    afterSequence: after,
    throughSequence: through,
    nextSequence: more ? after + 1 : null,
    events: [
      {
        eventType: "assistant-message",
        eventId: `event:${runId}:${String(after + 1)}`,
        sequence: after + 1,
        occurredAt: NOW,
        content: runId,
      },
    ],
  });
}
