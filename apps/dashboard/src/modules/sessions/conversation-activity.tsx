import type { CanonicalRunEvent } from "@marea/protocol";
import type { SessionsMessages } from "./sessions-messages.js";

/** Render recorded activity as inert text, including private teacher-only skill reads. */
export function ActivityDetails({
  event,
  messages: m,
}: {
  readonly event: CanonicalRunEvent;
  readonly messages: SessionsMessages;
}) {
  switch (event.eventType) {
    case "tool-started":
      return (
        <>
          <Truncated value={event.truncated} text={m.truncated} />
          <details>
            <summary>{m.arguments}</summary>
            <pre>{event.arguments}</pre>
          </details>
        </>
      );
    case "tool-finished":
      return (
        <>
          <Truncated value={event.truncated} text={m.truncated} />
          <details open={event.failed}>
            <summary>{m.output}</summary>
            <pre>{event.result}</pre>
          </details>
        </>
      );
    case "approval-requested":
      return event.content === undefined ? null : (
        <>
          <p>{event.path}</p>
          <Truncated value={event.truncated === true} text={m.truncated} />
          <details>
            <summary>{m.proposed}</summary>
            <pre>{event.content}</pre>
          </details>
        </>
      );
    case "approval-resolved":
      return event.reason === undefined ? null : <p>{event.reason}</p>;
    case "questions-resolved":
      return (
        <div>
          {event.questions.map((question, index) => (
            <section key={index}>
              <strong>{question.text}</strong>
              <ul>
                {question.choices.map((choice) => (
                  <li
                    key={choice}
                    className={choice === event.answers[index] ? "selected-answer" : undefined}
                  >
                    {choice === event.answers[index] ? "✓ " : ""}
                    {choice}
                  </li>
                ))}
              </ul>
              <pre>{event.answers[index]}</pre>
            </section>
          ))}
        </div>
      );
  }
  return null;
}
function Truncated({ value, text }: { readonly value: boolean; readonly text: string }) {
  return value ? <p className="activity-warning">{text}</p> : null;
}
