// Explicit, synthetic-only acceptance. Run with Bun --env-file=<private .env>.
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import plugin from "../../../plugins/telemetry/langfuse/src/index.ts";
import { observabilityFixture, addTraceEvent } from "../src/observability/observability.fixture.ts";
import { readTraceTurn } from "../src/platform/persistence/sqlite-trace-turn.ts";
import { buildSessionTrace } from "../src/observability/trace-builder.ts";
import { USAGE_POLICY } from "../test-support/usage-fixture.ts";

const values = {
  endpoint: process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
};
assert(
  Object.values(values).every(Boolean),
  "Set Langfuse URL and keys in a private environment file.",
);
const f = observabilityFixture();
const began = Date.now();
const time = (offset) => new Date(began + offset).toISOString();
try {
  f.catalog.splice(0, f.catalog.length, plugin);
  await f.save({ pluginId: plugin.manifest.id, values });
  const events = [
    {
      eventType: "student-message",
      messageId: "message:acceptance",
      content: "Synthetic student: write a Python greeting.",
    },
    {
      eventType: "model-diagnostic",
      requestId: "request:acceptance",
      phase: "request",
      status: "started",
      content: '{"messages":[{"role":"user","content":"Write a Python greeting"}]}',
      truncated: false,
    },
    {
      eventType: "model-diagnostic",
      requestId: "request:acceptance",
      phase: "response",
      status: "completed",
      content: "I will ask before writing.",
      truncated: false,
    },
    {
      eventType: "questions-resolved",
      messageId: "message:acceptance",
      interruptId: "question:one",
      questions: [{ text: "Use Python?", choices: ["Yes", "No"], required: true }],
      answers: ["Yes"],
      cancelled: false,
    },
    {
      eventType: "approval-requested",
      messageId: "message:acceptance",
      approvalId: "approval:one",
      tool: "write",
      summary: "Create greeting.py",
      path: "greeting.py",
      content: "print('hello')",
    },
    {
      eventType: "approval-resolved",
      messageId: "message:acceptance",
      approvalId: "approval:one",
      decision: "approved",
    },
    {
      eventType: "tool-started",
      messageId: "message:acceptance",
      callId: "call:one",
      name: "write",
      target: "greeting.py",
      arguments: JSON.stringify({ path: "greeting.py", content: "print('hello')" }),
      truncated: false,
    },
    {
      eventType: "tool-finished",
      messageId: "message:acceptance",
      callId: "call:one",
      failed: false,
      result: "Synthetic file created",
      truncated: false,
    },
    {
      eventType: "assistant-message",
      messageId: "message:acceptance",
      content: "The synthetic greeting is ready.",
    },
    { eventType: "turn-ended", messageId: "message:acceptance", state: "completed" },
  ];
  events.forEach((event, index) =>
    addTraceEvent(f.database, index + 3, { ...event, occurredAt: time(index * 100) }),
  );
  f.database.execute("INSERT INTO marea_usage_accounts VALUES('run:a','tutoring',?1,?2)", [
    JSON.stringify(USAGE_POLICY),
    time(0),
  ]);
  f.database.execute(
    `INSERT INTO marea_usage_attempts VALUES('attempt:acceptance','run:a','tutoring','request:acceptance',1,'settled',12,8,20,?1,?2)`,
    [time(100), time(200)],
  );
  await f.runtime.tick();
  console.log(
    JSON.stringify({
      delivery: f.runtime.status(),
      failure: f.database.readOne("SELECT last_error FROM marea_trace_outbox"),
    }),
  );
  assert.equal(f.runtime.status().sent, 1, "Langfuse must acknowledge the queued turn");
  const settings = f.store.read().observability;
  const trace = buildSessionTrace(
    readTraceTurn(f.database, { runId: "run:a", through: 12, attempts: 0 }),
    settings.namespace,
    "synthetic-release",
  );
  const receipt = {
    traceId: trace.id,
    sessionId: trace.sessionId,
    from: time(-60000),
    until: time(3600000),
    spans: trace.spans.map((s) => ({
      id: s.id,
      parentId: s.parentId,
      type: s.type,
      name: s.name,
      input: s.input,
      output: s.output,
      usage: s.usage,
    })),
  };
  const receiptPath = process.env.MAREA_ACCEPTANCE_RECEIPT ?? "/tmp/marea-langfuse-acceptance.json";
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({ accepted: true, spanCount: trace.spans.length, receipt: receiptPath }),
  );
} finally {
  await f.runtime.stop();
  f.database.close();
}
