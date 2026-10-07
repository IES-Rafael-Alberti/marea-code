import { expect, it } from "vitest";
import { connectionTestTrace } from "./test-trace.js";
it("creates a collector-compatible synthetic event independent of all student identities", () => {
  const now = "2026-10-08T00:00:00.000Z";
  const trace = connectionTestTrace(now, "test-release");
  expect(trace.id).toMatch(/^[a-f0-9]{32}$/u);
  expect(trace).toEqual({
    version: 1,
    id: trace.id,
    sessionId: `marea-test-${trace.id}`,
    userId: "marea-connection-test",
    classId: "synthetic",
    release: "test-release",
    spans: [
      {
        metadata: { synthetic: true },
        failed: false,
        input: "Synthetic connection test. No student data.",
        output: "Marea observability",
        startedAt: now,
        endedAt: now,
        type: "event",
        name: "Marea connection test",
        id: trace.id.slice(0, 16),
      },
    ],
  });
  expect(connectionTestTrace(now, "test-release").id).not.toBe(trace.id);
});
