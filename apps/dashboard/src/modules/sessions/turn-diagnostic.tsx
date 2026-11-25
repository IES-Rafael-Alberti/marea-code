import { useState } from "react";
import type { CanonicalRunEvent } from "@marea/protocol";

import type { SessionsMessages } from "./sessions-messages.js";

type TurnDiagnosticEvent = Extract<CanonicalRunEvent, { eventType: "turn-diagnostic" }>;

/** Everything needed to report the failure, in one block the teacher can paste into an issue. */
export function technicalDetail(event: TurnDiagnosticEvent): string {
  return [
    `category: ${event.category}`,
    `retryable: ${String(event.retryable)}`,
    `client: ${event.client.version} (${event.client.platform})`,
    ...(event.requestId === undefined ? [] : [`request: ${event.requestId}`]),
    `exception: ${event.exception.name}: ${event.exception.message}`,
    ...event.causes.map((cause) => `caused by: ${cause.name}: ${cause.message}`),
    "",
    event.stack,
    ...(event.modelResponse === undefined ? [] : ["", "model response:", event.modelResponse]),
  ].join("\n");
}

/** A failed attempt's technical detail: closed by default, copied as text on request. */
export function TurnDiagnostic({
  event,
  messages: m,
  copy = (text) => navigator.clipboard.writeText(text),
}: {
  readonly event: TurnDiagnosticEvent;
  readonly messages: SessionsMessages;
  readonly copy?: (text: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const text = technicalDetail(event);
  return (
    <article className="conversation-event event-turn-diagnostic">
      <header>
        <strong>{m.technicalDetail}</strong>
        <time dateTime={event.occurredAt}>{event.occurredAt.slice(11, 19)}</time>
      </header>
      <div className="message-text">{event.category}</div>
      <details>
        <summary>{m.showDetail}</summary>
        <pre>{text}</pre>
        <button
          type="button"
          onClick={() => {
            void copy(text).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? m.copied : m.copyDetail}
        </button>
      </details>
    </article>
  );
}
