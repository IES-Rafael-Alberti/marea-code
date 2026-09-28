import {
  MAX_RUN_EVENTS_REQUEST_BYTES,
  type AppendRunEventsRequest,
  type CanonicalRunEvent,
} from "@marea/protocol";

const encoder = new TextEncoder();

/** Send a bounded prefix of the durable envelope; partial acknowledgements retain its remainder. */
export function boundedEventDelivery(request: AppendRunEventsRequest): AppendRunEventsRequest {
  const events: CanonicalRunEvent[] = [];
  let bytes = encoder.encode(JSON.stringify({ ...request, events })).byteLength;
  for (const event of request.events) {
    const added = encoder.encode(JSON.stringify(event)).byteLength + (events.length === 0 ? 0 : 1);
    if (bytes + added > MAX_RUN_EVENTS_REQUEST_BYTES) break;
    events.push(event);
    bytes += added;
  }
  if (events.length === 0) throw new Error("A run event exceeds the delivery size limit.");
  return { ...request, events };
}
