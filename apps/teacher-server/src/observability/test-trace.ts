import { randomUUID } from "node:crypto";
import type { SessionTrace } from "@marea/plugin-api";
export function connectionTestTrace(now: string, release: string): SessionTrace {
  const id = randomUUID().replaceAll("-", "");
  return {
    version: 1,
    id,
    sessionId: `marea-test-${id}`,
    userId: "marea-connection-test",
    classId: "synthetic",
    release,
    spans: [
      {
        id: id.slice(0, 16),
        name: "Marea connection test",
        type: "event",
        startedAt: now,
        endedAt: now,
        input: "Synthetic connection test. No student data.",
        output: "Marea observability",
        failed: false,
        metadata: { synthetic: true },
      },
    ],
  };
}
