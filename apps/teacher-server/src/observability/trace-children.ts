import type { CanonicalRunEvent } from "@marea/protocol";
import type { SessionTraceSpan } from "@marea/plugin-api";
import type { TraceTurn } from "./contracts.js";

export function traceChildren(
  turn: TraceTurn,
  parentId: string,
  key: (id: string) => string,
): SessionTraceSpan[] {
  const span = (
    event: CanonicalRunEvent,
    type: SessionTraceSpan["type"],
    name: string,
    input: string,
    output: string,
    end?: CanonicalRunEvent,
    failed = false,
  ): SessionTraceSpan => {
    const clockSkew = end !== undefined && end.occurredAt < event.occurredAt;
    return {
      id: key(event.eventId),
      parentId,
      type,
      name,
      input,
      output,
      failed,
      startedAt: event.occurredAt,
      ...(end === undefined
        ? {}
        : {
            endedAt: clockSkew ? event.occurredAt : end.occurredAt,
          }),
      metadata: {
        eventType: event.eventType,
        timingComplete: end !== undefined,
        clockSkew,
        truncated:
          ("truncated" in event && event.truncated === true) ||
          (end !== undefined && "truncated" in end && end.truncated === true),
      },
    };
  };
  const result: SessionTraceSpan[] = [];
  for (const event of turn.events) {
    if (event.eventType === "model-diagnostic" && event.phase === "request") {
      result.push(...generationSpans(turn, event, span, key));
    } else if (event.eventType === "tool-started") {
      const end = turn.events.find(
        (e) => e.eventType === "tool-finished" && e.callId === event.callId,
      );
      result.push(
        span(
          event,
          "tool",
          event.name,
          event.arguments,
          end?.eventType === "tool-finished" ? end.result : "",
          end,
          end?.eventType === "tool-finished" && end.failed,
        ),
      );
    } else if (event.eventType === "approval-requested") {
      const end = turn.events.find(
        (e) => e.eventType === "approval-resolved" && e.approvalId === event.approvalId,
      );
      result.push(
        span(
          event,
          "span",
          "Approval",
          JSON.stringify(event),
          end === undefined ? "" : JSON.stringify(end),
          end,
        ),
      );
    } else if (
      ["questions-resolved", "turn-failed", "project-change", "workspace-edit"].includes(
        event.eventType,
      )
    ) {
      result.push(
        span(
          event,
          "event",
          event.eventType,
          "",
          JSON.stringify(event),
          event,
          event.eventType === "turn-failed",
        ),
      );
    }
  }
  return result;
}

function generationSpans(
  turn: TraceTurn,
  event: Extract<CanonicalRunEvent, { eventType: "model-diagnostic" }>,
  span: (
    event: CanonicalRunEvent,
    type: SessionTraceSpan["type"],
    name: string,
    input: string,
    output: string,
    end?: CanonicalRunEvent,
    failed?: boolean,
  ) => SessionTraceSpan,
  key: (id: string) => string,
): SessionTraceSpan[] {
  const end = turn.events.find(
    (e) =>
      e.eventType === "model-diagnostic" &&
      e.requestId === event.requestId &&
      e.phase === "response",
  );
  const base = span(
    event,
    "generation",
    "Model generation",
    event.content,
    end?.eventType === "model-diagnostic" ? end.content : "",
    end,
    end?.eventType === "model-diagnostic" && end.status !== "completed",
  );
  const generation = {
    ...base,
    model: turn.model,
    metadata: {
      ...base.metadata,
      provider: turn.provider,
      requestId: event.requestId,
      complete: end !== undefined,
      correlation: "ordered-session-events",
    },
  };
  // Generation groups retries; usage lives only on attempts to avoid double accounting.
  const attempts = turn.usage.filter(
    (a) => a.requestId === event.requestId && a.purpose === "tutoring",
  );
  const result: SessionTraceSpan[] = [
    attempts.length ? { ...generation, type: "span" } : generation,
  ];
  for (const attempt of attempts)
    result.push({
      ...generation,
      id: key(`${event.eventId}:${String(attempt.attempt)}`),
      parentId: generation.id,
      name: `Model attempt ${String(attempt.attempt)}`,
      type: "generation",
      input: event.content,
      output: attempt === attempts.at(-1) ? generation.output : "",
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt ?? undefined,
      failed: attempt.state !== "settled",
      metadata: {
        ...generation.metadata,
        attempt: attempt.attempt,
        state: attempt.state,
        costUnits: attempt.costUnits ?? "unknown",
        costUnit: attempt.costUnit,
        timingComplete: attempt.endedAt !== null,
      },
      ...(attempt.inputTokens === null || attempt.outputTokens === null
        ? {}
        : { usage: { input: attempt.inputTokens, output: attempt.outputTokens } }),
    });

  return result;
}
