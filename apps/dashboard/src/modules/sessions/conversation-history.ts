import { EventIdSchema, type CanonicalRunEvent } from "@marea/protocol";

type AssistantEvent = Extract<
  CanonicalRunEvent,
  { eventType: "assistant-progress" | "assistant-message" }
>;
interface TextPosition {
  offset: number;
  block?: { index: number; event: AssistantEvent };
  length: number;
}

/** Render cumulative snapshots as text blocks separated by tool executions. */
export function conversationHistory(
  events: readonly CanonicalRunEvent[],
): readonly CanonicalRunEvent[] {
  const latest = new Map<string | undefined, AssistantEvent>();
  for (const event of events) {
    if (event.eventType === "assistant-progress" || event.eventType === "assistant-message")
      latest.set(event.messageId, event);
  }
  const positions = new Map<string, TextPosition>();
  const result: CanonicalRunEvent[] = [];
  const showText = (event: AssistantEvent, position: TextPosition, end = event.content.length) => {
    const content = event.content.slice(position.offset, end);
    if (content.length === 0) return;
    if (position.block === undefined) {
      const block = { ...event, content };
      position.block = { index: result.length, event: block };
      result.push(block);
    } else {
      const previous = position.block.event;
      result[position.block.index] = {
        ...event,
        content,
        eventId: previous.eventId,
        occurredAt: previous.occurredAt,
        sequence: previous.sequence,
      };
    }
    position.length = end;
  };
  for (const event of events) {
    if (event.eventType === "model-diagnostic") continue;
    if (
      (event.eventType === "assistant-progress" || event.eventType === "assistant-message") &&
      event.messageId !== undefined
    ) {
      const position = positions.get(event.messageId) ?? { offset: 0, length: 0 };
      positions.set(event.messageId, position);
      showText(event, position);
      continue;
    }
    if (event.eventType === "tool-started") {
      const position = positions.get(event.messageId) ?? { offset: 0, length: 0 };
      const end = event.assistantTextOffset ?? position.length;
      const text = latest.get(event.messageId);
      if (text !== undefined) {
        showText(
          {
            ...text,
            eventId: EventIdSchema.parse(`text-block:${String(event.sequence)}`),
            occurredAt: event.occurredAt,
            sequence: event.sequence,
          },
          position,
          end,
        );
      }
      positions.set(event.messageId, { offset: end, length: end });
    }
    result.push(event);
  }
  return result;
}
