import { CanonicalRunEventSchema } from "@marea/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConversationEvent } from "./conversation-events.js";
import { sessionsMessages } from "./sessions-messages.js";
const base = {
  eventId: "event:activity",
  sequence: 3,
  occurredAt: "2026-09-20T08:00:00.000Z",
  messageId: "message:one",
};
function render(payload: object) {
  return renderToStaticMarkup(
    <ConversationEvent
      event={CanonicalRunEventSchema.parse({ ...base, ...payload })}
      messages={sessionsMessages("es")}
    />,
  );
}
it("shows calls, targets, arguments, bounded outputs and errors as escaped expandable evidence", () => {
  const start = render({
    eventType: "tool-started",
    callId: "read",
    name: "marea_read_skill",
    target: "private/SKILL.md",
    arguments: '<script>alert("x")</script>',
    truncated: true,
  });
  expect(start).toContain("<strong>marea_read_skill</strong>");
  expect(start).toContain("<p>private/SKILL.md</p>");
  expect(start).toContain("Argumentos");
  expect(start).toContain("Contenido recortado");
  expect(start).toContain("&lt;script&gt;");
  expect(start).not.toContain("<script>");
  for (const failed of [false, true]) {
    const finish = render({
      eventType: "tool-finished",
      callId: "read",
      result: "Recorded output",
      failed,
      truncated: false,
    });
    expect(finish).toContain(failed ? "Error de herramienta" : "Resultado de herramienta");
    expect(finish.includes('<details open="">')).toBe(failed);
    expect(finish).toContain("Recorded output");
    expect(finish).not.toContain("Contenido recortado");
  }
});
it("shows proposed file contents and rejection reasons", () => {
  const write = render({
    eventType: "approval-requested",
    approvalId: "approval:1",
    tool: "write_file",
    summary: "Write",
    path: "main.py",
    content: "print(1)",
    truncated: false,
  });
  expect(write).toContain("main.py");
  expect(write).toContain("print(1)");
  expect(write).toContain("Contenido propuesto");
  const rejected = render({
    eventType: "approval-resolved",
    approvalId: "approval:1",
    decision: "rejected",
    reason: "I want to try myself",
  });
  expect(rejected).toContain("<p>I want to try myself</p>");
});
it.each([false, true])(
  "shows questions, every choice and the selected or free answer (cancelled=%s)",
  (cancelled) => {
    const html = render({
      eventType: "questions-resolved",
      interruptId: "q1",
      questions: [
        { text: "Why?", choices: ["A", "B"], required: true },
        { text: "Explain", choices: [], required: false },
      ],
      answers: cancelled ? [] : ["B", "Because"],
      cancelled,
    });
    expect(html).toContain("Why?");
    expect(html).toContain("Explain");
    expect(html).toContain("<li>A</li>");
    expect(html.includes('class="selected-answer"')).toBe(!cancelled);
    expect(html.includes("✓ B")).toBe(!cancelled);
    expect(html).toContain(cancelled ? "Canceladas" : "Because");
  },
);

it.each([undefined, false, true])(
  "marks a truncated write proposal explicitly (%s)",
  (truncated) => {
    const html = render({
      eventType: "approval-requested",
      approvalId: "approval:1",
      tool: "write_file",
      summary: "Write",
      content: "print(1)",
      ...(truncated === undefined ? {} : { truncated }),
    });
    expect(html.includes('class="activity-warning"')).toBe(truncated === true);
  },
);
it("renders generic student-history markers without pretending they contain tool details", () => {
  const html = renderToStaticMarkup(
    <ConversationEvent
      event={CanonicalRunEventSchema.parse({
        eventType: "internal-activity",
        eventId: "event:marker",
        sequence: 1,
        occurredAt: base.occurredAt,
      })}
      messages={sessionsMessages("es")}
    />,
  );
  expect(html).toContain("<strong>Preparación del tutor</strong>");
});
