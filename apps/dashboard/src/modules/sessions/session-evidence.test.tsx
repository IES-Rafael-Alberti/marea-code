import { CanonicalRunEventSchema } from "@marea/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConversationEvent } from "./conversation-events.js";
import { TurnSummary } from "./turn-summary.js";
import { sessionsMessages } from "./sessions-messages.js";
const m = sessionsMessages("en");
function event(payload: Record<string, string | boolean | object>) {
  return CanonicalRunEventSchema.parse({
    eventId: "event:evidence",
    sequence: 1,
    occurredAt: "2026-09-20T10:00:00.000Z",
    ...(payload.eventType === "project-context" || payload.eventType === "model-diagnostic"
      ? {}
      : { messageId: "message:one" }),
    ...payload,
  });
}
it.each([
  [
    {
      eventType: "project-change",
      actor: "student",
      summary: "Student edits",
      patch: "+new\n-old\n unchanged",
      truncated: true,
    },
    "Student edits",
  ],
  [
    {
      eventType: "project-change",
      actor: "agent",
      summary: "Agent edits",
      patch: "context",
      truncated: false,
    },
    "Agent edits",
  ],
  [
    {
      eventType: "project-change",
      actor: "unknown",
      summary: "Uncertain attribution",
      patch: "",
      truncated: false,
    },
    "Uncertain attribution",
  ],
  [
    {
      eventType: "project-context",
      cwd: "/project",
      branch: "main",
      repositoryUrl: "https://example.test/repo",
    },
    "/project · main · https://example.test/repo",
  ],
  [{ eventType: "turn-ended", state: "completed" }, m.turnEnded],
  [{ eventType: "turn-ended", state: "cancelled" }, m.interrupted],
  [{ eventType: "turn-failed", category: "offline", retryable: true }, m.retryable],
  [{ eventType: "turn-failed", category: "invalid", retryable: false }, m.notRetryable],
  [
    { eventType: "assistant-progress", content: "Streaming now", truncated: false },
    "Streaming now",
  ],
])("renders evidence %j without raw per-message JSON", (payload, text) => {
  const html = renderToStaticMarkup(<ConversationEvent event={event(payload)} messages={m} />);
  expect(html).toContain(text);
  expect(html).not.toContain("Technical details");
  if ("truncated" in payload && payload.truncated) {
    expect(html).toContain(m.truncated);
    expect(html).toContain('class="diff-added"');
    expect(html).toContain('class="diff-removed"');
    expect(html).toContain('class="diff-context"');
  }
});
it("keeps diagnostics out of conversation and counts only the chosen turn", () => {
  const diagnostic = event({
    eventType: "model-diagnostic",
    requestId: "request:one",
    phase: "request",
    status: "started",
    content: "private model envelope",
    truncated: false,
  });
  expect(renderToStaticMarkup(<ConversationEvent event={diagnostic} messages={m} />)).toBe("");
  const events = [
    diagnostic,
    event({ eventType: "student-message", content: "Other", messageId: "message:other" }),
    event({ eventType: "student-message", content: "Current" }),
    event({
      eventType: "approval-requested",
      messageId: "message:other",
      approvalId: "approval:other",
      tool: "write_file",
      summary: "Other turn",
    }),
    event({
      eventType: "approval-requested",
      approvalId: "approval:edit",
      tool: "edit_file",
      summary: "Edit",
    }),

    event({
      eventType: "questions-resolved",
      interruptId: "question:one",
      questions: [
        { text: "Why?", choices: [], required: true },
        { text: "How?", choices: [], required: true },
      ],
      answers: ["Because", "By testing"],
      cancelled: false,
    }),
    event({
      eventType: "questions-resolved",
      interruptId: "question:two",
      questions: [{ text: "Another?", choices: [], required: false }],
      answers: [],
      cancelled: true,
    }),
    event({
      eventType: "approval-requested",
      approvalId: "approval:one",
      tool: "write_file",
      summary: "Run",
    }),
    event({ eventType: "approval-resolved", approvalId: "approval:one", decision: "approved" }),
    event({
      eventType: "approval-requested",
      approvalId: "approval:two",
      tool: "delete",
      summary: "Delete",
    }),
    event({
      eventType: "approval-requested",
      approvalId: "approval:command",
      tool: "execute",
      summary: "Command",
    }),
    event({ eventType: "approval-resolved", approvalId: "approval:command", decision: "approved" }),
    event({ eventType: "approval-resolved", approvalId: "approval:two", decision: "rejected" }),
    ...["execute", "marea_execute", "read_file", "marea_read_skill"].map((name) =>
      event({
        eventType: "tool-started",
        callId: name,
        name,
        target: `/target/${name}`,
        arguments: "{}",
        truncated: false,
      }),
    ),
    ...[true, false].map((failed) =>
      event({
        eventType: "tool-finished",
        callId: "call:one",
        failed,
        result: "done",
        truncated: false,
      }),
    ),
  ];
  const html = renderToStaticMarkup(
    <TurnSummary events={events} messageId="message:one" messages={m} />,
  );
  expect(html).toContain(`${m.questions}: 3`);
  expect(html).toContain(`${m.writes}: 3`);
  expect(html).toContain(`${m.approved}: 1`);
  expect(html).toContain(`${m.rejected}: 1`);
  expect(html).toContain(`${m.commands}: 2`);
  expect(html).toContain(`${m.toolFailed}: 1`);
  expect(html).toContain(`${m.skillsRead}: 1`);
  expect(html).toBe(
    `<p class="turn-summary">${m.questions}: 3 · ${m.writes}: 3 · ${m.approved}: 1 · ${m.rejected}: 1 · ${m.commands}: 2 · ${m.toolFailed}: 1 · ${m.skillsRead}: 1</p>`,
  );
});

it.each(["student", "agent", "unknown"] as const)(
  "labels %s attribution independently from diff contents",
  (actor) => {
    const heading =
      actor === "student" ? m.studentEdit : actor === "agent" ? m.agentEdit : m.unknownEdit;
    const html = renderToStaticMarkup(
      <ConversationEvent
        event={event({
          eventType: "project-change",
          actor,
          summary: "One changed file",
          patch: "+value",
          truncated: false,
        })}
        messages={m}
      />,
    );
    expect(html).toContain(`<strong>${heading}</strong>`);
    expect(html).toContain('class="conversation-event event-project-change"');
    expect(html).toContain("+value\n</span>");
  },
);
it("omits empty context fields and keeps failure category, retryability and terminal text", () => {
  const context = renderToStaticMarkup(
    <ConversationEvent
      event={event({
        eventType: "project-context",
        cwd: "/project",
        branch: "",
        repositoryUrl: "",
      })}
      messages={m}
    />,
  );
  expect(context).toContain("<p>/project</p>");
  const failed = renderToStaticMarkup(
    <ConversationEvent
      event={event({ eventType: "turn-failed", category: "offline", retryable: true })}
      messages={m}
    />,
  );
  expect(failed).toContain(`<p>offline · ${m.retryable}</p>`);
  const ended = renderToStaticMarkup(
    <ConversationEvent
      event={event({ eventType: "turn-ended", state: "completed" })}
      messages={m}
    />,
  );
  expect(ended).toContain('<div class="message-text"><p></p></div>');
});
