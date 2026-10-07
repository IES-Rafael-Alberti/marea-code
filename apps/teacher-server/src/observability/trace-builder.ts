import { createHash } from "node:crypto";
import type { SessionTrace, SessionTraceSpan } from "@marea/plugin-api";
import type { TraceTurn } from "./contracts.js";
import { traceChildren } from "./trace-children.js";

export function traceKey(...parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}
export function buildSessionTrace(
  turn: TraceTurn,
  namespace: string,
  release: string,
): SessionTrace {
  const first = turn.events[0];
  const last = turn.events.at(-1);
  if (first === undefined || last === undefined) throw new Error("Empty trace.");
  const clockSkew = last.occurredAt < first.occurredAt;
  const id = traceKey(
    namespace,
    turn.runId,
    "messageId" in last ? (last.messageId ?? last.sequence) : last.sequence,
  );
  const rootId = traceKey(id, "root").slice(0, 16);
  const input = turn.events
    .filter((e) => e.eventType === "student-message")
    .map((e) => e.content)
    .join("\n");
  const output = turn.events
    .filter((e) => e.eventType === "assistant-message")
    .map((e) => e.content)
    .join("\n");
  const root: SessionTraceSpan = {
    id: rootId,
    name: "Tutoring turn",
    type: "agent",
    startedAt: first.occurredAt,
    endedAt: clockSkew ? first.occurredAt : last.occurredAt,
    input,
    output,
    failed: last.eventType === "turn-failed",
    metadata: {
      terminalEvent: last.eventType,
      capturedEvents: turn.events.length,
      modelDiagnostics: turn.events.some((e) => e.eventType === "model-diagnostic"),
      clockSkew,
    },
  };
  return {
    version: 1,
    id,
    sessionId: traceKey(namespace, turn.runId),
    userId: traceKey(namespace, turn.studentId),
    classId: traceKey(namespace, turn.classId),
    release,
    spans: [root, ...traceChildren(turn, rootId, (key) => traceKey(id, key).slice(0, 16))],
  };
}
