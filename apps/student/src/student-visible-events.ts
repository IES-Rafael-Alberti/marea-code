import type { AgentEvent } from "./contracts.js";

/** Keep didactic tool payloads on the model side of the student view boundary. */
export async function* studentVisibleEvents(
  events: AsyncIterable<AgentEvent>,
  privateCalls: Set<string>,
  thinking: () => void,
): AsyncIterable<AgentEvent> {
  for await (const event of events) {
    switch (event.type) {
      case "tool-started":
        if (event.name === "marea_read_skill") {
          privateCalls.add(event.callId);
          thinking();
          continue;
        }
        break;
      case "tool-finished":
        if (privateCalls.has(event.callId)) continue;
        break;
    }
    yield event;
  }
}
