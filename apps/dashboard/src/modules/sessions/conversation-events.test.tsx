import { CanonicalRunEventSchema } from "@marea/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConversationEvent } from "./conversation-events.js";
import { sessionsMessages } from "./sessions-messages.js";

it.each(["en", "es"] as const)(
  "renders each durable event as readable %s evidence with optional raw detail",
  (locale) => {
    const m = sessionsMessages(locale);
    const examples = [
      [{ eventType: "student-message", content: "My question" }, m.student, "My question"],
      [{ eventType: "assistant-message", content: "A hint" }, m.assistant, "A hint"],
      [
        {
          eventType: "approval-requested",
          approvalId: "approval:one",
          tool: "write_file",
          summary: "Create an example",
        },
        m.approval,
        "write_file",
      ],
      [
        { eventType: "approval-resolved", approvalId: "approval:one", decision: "approved" },
        m.approved,
        "",
      ],
      [
        { eventType: "approval-resolved", approvalId: "approval:one", decision: "rejected" },
        m.rejected,
        "",
      ],
      [
        {
          eventType: "workspace-edit",
          approvalId: "approval:one",
          operation: "created",
          path: "main.py",
          digest: `sha256:${"a".repeat(64)}`,
        },
        m.edit,
        "main.py",
      ],
      [{ eventType: "run-activated" }, m.opened, ""],
      [{ eventType: "run-closed", reason: "student-exit" }, m.finished, ""],
      [{ eventType: "tutor-startup", state: "completed" }, m.startup, ""],
    ] as const;
    for (const [payload, heading, content] of examples) {
      const event = CanonicalRunEventSchema.parse({
        eventId: "event:one",
        sequence: 1,
        occurredAt: "2026-09-19T08:01:02.000Z",
        ...payload,
      });
      const html = renderToStaticMarkup(<ConversationEvent event={event} messages={m} />);
      expect(html).toMatchSnapshot(`${payload.eventType} ${heading}`);
      expect(html).toContain(`<strong>${heading}</strong>`);
      expect(html).toContain(content);
      expect(html).toContain('dateTime="2026-09-19T08:01:02.000Z"');
      expect(html).toContain("08:01:02");
      expect(html).not.toContain("Technical details");
      expect(html).not.toContain("Detalles técnicos");
      expect(html).not.toContain("<details open");
    }
  },
);
it("renders closed and unfinished code fences while escaping model HTML", () => {
  const event = CanonicalRunEventSchema.parse({
    eventId: "event:one",
    sequence: 1,
    occurredAt: "2026-09-19T08:01:02.000Z",
    eventType: "assistant-message",
    content: "<script>bad()</script>\n```python\nprint(1)\n```\nThen:\n```\nprint(2)",
  });
  const html = renderToStaticMarkup(
    <ConversationEvent event={event} messages={sessionsMessages("en")} />,
  );
  expect(html).toMatchSnapshot("escaped text and fences");
  expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("<code>print(1)</code>");
  expect(html).toContain("<code>print(2)</code>");
});
it("formats conversation turns as Markdown but keeps tool targets and summaries literal", () => {
  const render = (payload: object) =>
    renderToStaticMarkup(
      <ConversationEvent
        event={CanonicalRunEventSchema.parse({
          eventId: "event:one",
          sequence: 1,
          occurredAt: "2026-09-19T08:01:02.000Z",
          ...payload,
        })}
        messages={sessionsMessages("en")}
      />,
    );
  for (const eventType of ["student-message", "assistant-message", "assistant-progress"])
    expect(
      render({
        eventType,
        content: "**Check** `x`",
        messageId: "message:one",
        ...(eventType === "assistant-progress" ? { truncated: false } : {}),
      }),
    ).toContain("<p><strong>Check</strong> <code>x</code></p>");
  expect(
    render({
      eventType: "tool-started",
      callId: "call",
      messageId: "message:one",
      name: "marea_read_project",
      target: "/src/__init__.py",
      arguments: "{}",
      truncated: false,
    }),
  ).toContain("<p>/src/__init__.py</p>");
});
