import { ActivityDetails } from "./conversation-activity.js";
import type { CanonicalRunEvent } from "@marea/protocol";
import type { SessionsMessages } from "./sessions-messages.js";
/** Model text remains React text, never HTML or executable links. */
export function ConversationEvent({
  event,
  messages: m,
}: {
  readonly event: CanonicalRunEvent;
  readonly messages: SessionsMessages;
}) {
  if (event.eventType === "model-diagnostic") return null;
  if (isEvidenceEvent(event)) return <EvidenceEvent event={event} messages={m} />;
  let heading: string;
  let content = "";
  switch (event.eventType) {
    case "tool-started":
      heading = event.name;
      content = event.target;
      break;
    case "tool-finished":
      heading = event.failed ? m.toolFailed : m.toolResult;
      break;
    case "questions-resolved":
      heading = event.cancelled ? m.cancelled : m.questions;
      break;
    case "student-message":
      heading = m.student;
      content = event.content;
      break;
    case "assistant-progress":
    case "assistant-message":
      heading = m.assistant;
      content = event.content;
      break;
    case "approval-requested":
      heading = m.approval;
      content = `${event.tool}\n${event.summary}`;
      break;
    case "approval-resolved":
      heading = event.decision === "approved" ? m.approved : m.rejected;
      break;
    case "workspace-edit":
      heading = m.edit;
      content = event.path;
      break;
    case "run-activated":
      heading = m.opened;
      break;
    case "run-closed":
      heading = m.finished;
      break;
    case "internal-activity":
    case "tutor-startup":
      heading = m.startup;
      break;
  }
  return (
    <article className={`conversation-event event-${event.eventType}`}>
      <EventHeading heading={heading} date={event.occurredAt} content={content} />
      <ActivityDetails event={event} messages={m} />
    </article>
  );
}
function EvidenceEvent({
  event,
  messages: m,
}: {
  readonly event: Extract<
    CanonicalRunEvent,
    { eventType: "project-context" | "project-change" | "turn-ended" | "turn-failed" }
  >;
  readonly messages: SessionsMessages;
}) {
  let heading: string;
  let content = "";
  switch (event.eventType) {
    case "project-context":
      heading = m.projectContext;
      content = [event.cwd, event.branch, event.repositoryUrl].filter(Boolean).join(" · ");
      break;
    case "project-change":
      heading =
        event.actor === "student"
          ? m.studentEdit
          : event.actor === "agent"
            ? m.agentEdit
            : m.unknownEdit;
      content = event.summary;
      break;
    case "turn-ended":
      heading = event.state === "cancelled" ? m.interrupted : m.turnEnded;
      break;
    case "turn-failed":
      heading = m.turnFailed;
      content = `${event.category} · ${event.retryable ? m.retryable : m.notRetryable}`;
      break;
  }
  return (
    <article className={`conversation-event event-${event.eventType}`}>
      <EventHeading heading={heading} date={event.occurredAt} content={content} />
      {event.eventType === "project-change" && (
        <details>
          <summary>{m.diff}</summary>
          {event.truncated && <p>{m.truncated}</p>}
          <pre>
            {event.patch.split("\n").map((line, index) => (
              <span
                key={index}
                className={
                  line.startsWith("+")
                    ? "diff-added"
                    : line.startsWith("-")
                      ? "diff-removed"
                      : "diff-context"
                }
              >
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </details>
      )}
    </article>
  );
}
function MessageText({ text }: { readonly text: string }) {
  // Fences are display-only. Unclosed fences remain readable and no HTML is interpreted.
  return (
    <div className="message-text">
      {text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/u).map((part, index) =>
        part.startsWith("```") ? (
          <pre key={index}>
            <code>{part.replace(/```[^\n]*\n/u, "").replace(/```/u, "")}</code>
          </pre>
        ) : (
          <p key={index}>{part.trim()}</p>
        ),
      )}
    </div>
  );
}

function isEvidenceEvent(
  event: CanonicalRunEvent,
): event is Extract<
  CanonicalRunEvent,
  { eventType: "project-context" | "project-change" | "turn-ended" | "turn-failed" }
> {
  return (
    event.eventType === "project-context" ||
    event.eventType === "project-change" ||
    event.eventType === "turn-ended" ||
    event.eventType === "turn-failed"
  );
}

function EventHeading({
  heading,
  date,
  content,
}: {
  readonly heading: string;
  readonly date: string;
  readonly content: string;
}) {
  return (
    <>
      <header>
        <strong>{heading}</strong>
        <time dateTime={date}>{date.slice(11, 19)}</time>
      </header>
      <MessageText text={content} />
    </>
  );
}
