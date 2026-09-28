import type { CanonicalRunEvent } from "@marea/protocol";

interface ConversationGroup {
  readonly event: CanonicalRunEvent;
  result?: Extract<CanonicalRunEvent, { eventType: "tool-finished" }>;
}

/** Pair parallel calls for reading without changing the recorded execution order. */
export function conversationToolGroups(
  events: readonly CanonicalRunEvent[],
): readonly ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  const pending = new Map<string, ConversationGroup>();
  for (const event of events) {
    if (event.eventType === "tool-finished") {
      const key = JSON.stringify([event.messageId, event.callId]);
      const call = pending.get(key);
      if (call !== undefined) {
        call.result = event;
        pending.delete(key);
        continue;
      }
    }
    const group = { event };
    groups.push(group);
    if (event.eventType === "tool-started") {
      pending.set(JSON.stringify([event.messageId, event.callId]), group);
    }
  }
  return groups;
}
