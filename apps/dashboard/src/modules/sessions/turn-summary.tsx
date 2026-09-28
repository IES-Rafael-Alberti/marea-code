import type { CanonicalRunEvent } from "@marea/protocol";
import type { SessionsMessages } from "./sessions-messages.js";

export function TurnSummary({
  events,
  messageId,
  messages: m,
}: {
  readonly events: readonly CanonicalRunEvent[];
  readonly messageId: string;
  readonly messages: SessionsMessages;
}) {
  let questions = 0;
  const writes = new Set<string>();
  const skills = new Set<string>();
  let approved = 0;
  let rejected = 0;
  let commands = 0;
  let failures = 0;
  const selected = events.filter((event) => "messageId" in event && event.messageId === messageId);
  for (const event of selected) {
    switch (event.eventType) {
      case "questions-resolved":
        questions += event.questions.length;
        break;
      case "approval-requested":
        if (["write_file", "edit_file", "delete"].includes(event.tool))
          writes.add(event.approvalId);
        break;
      case "approval-resolved":
        if (!writes.has(event.approvalId)) break;
        switch (event.decision) {
          case "approved":
            approved++;
            break;
          case "rejected":
            rejected++;
            break;
        }
        break;
      case "tool-started":
        if (["execute", "marea_execute"].includes(event.name)) commands++;
        if (event.name === "marea_read_skill") skills.add(event.target);
        break;
      case "tool-finished":
        if (event.failed) failures++;
        break;
    }
  }
  return (
    <p className="turn-summary">
      {m.questions}: {questions} · {m.writes}: {writes.size} · {m.approved}: {approved} ·{" "}
      {m.rejected}: {rejected} · {m.commands}: {commands} · {m.toolFailed}: {failures} ·{" "}
      {m.skillsRead}: {skills.size}
    </p>
  );
}
