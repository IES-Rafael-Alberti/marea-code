import { STARTUP_MESSAGE_ID, type CanonicalRunEvent, type MessageId } from "@marea/protocol";
import type { AgentEvent, IdSource, QuestionReply, TurnAttemptIdentity } from "./contracts.js";
import type { LocalSession } from "./local-session.js";

type Activity = Extract<
  CanonicalRunEvent,
  {
    eventType:
      "tool-started" | "tool-finished" | "questions-resolved" | "turn-ended" | "turn-failed";
  }
>;
type Payload<T> = T extends Activity
  ? Omit<T, "eventId" | "sequence" | "occurredAt" | "messageId">
  : never;
export interface TeacherActivityOptions {
  readonly localSession: LocalSession;
  readonly ids: IdSource;
  readonly flushOutbox: () => Promise<void>;
}
export class TeacherActivity {
  constructor(private readonly options: TeacherActivityOptions) {}

  private async record(
    identity: TurnAttemptIdentity & { messageId: MessageId },
    key: string,
    payload: Payload<Activity>,
    sourceTime?: string,
  ): Promise<void> {
    await this.options.localSession.appendEvent(
      JSON.stringify([identity.messageId, identity.attemptId, key]),
      (sequence, occurredAt) => ({
        ...payload,
        sequence,
        occurredAt: sourceTime ?? occurredAt,
        messageId: identity.messageId,
        eventId: this.options.ids.event(),
      }),
    );
    await this.options.flushOutbox();
  }

  async terminal(
    identity: TurnAttemptIdentity & { messageId: MessageId },
    payload: Payload<Extract<Activity, { eventType: "turn-ended" | "turn-failed" }>>,
  ): Promise<void> {
    if (identity.messageId === STARTUP_MESSAGE_ID && payload.eventType === "turn-ended") return;
    await this.options.localSession.appendEvent(
      JSON.stringify([
        identity.messageId,
        payload.eventType === "turn-ended" ? "terminal" : identity.attemptId,
        payload.eventType,
      ]),
      (sequence, occurredAt) => ({
        ...payload,
        sequence,
        occurredAt,
        messageId: identity.messageId,
        eventId: this.options.ids.event(),
      }),
    );
  }

  async *observe(
    events: AsyncIterable<AgentEvent>,
    identity: TurnAttemptIdentity & { messageId: MessageId },
    assistantText: () => string,
  ): AsyncIterable<AgentEvent> {
    for await (const event of events) {
      if (event.type === "tool-started") {
        const argumentsText = JSON.stringify(event.arguments, null, 2);
        const target =
          event.arguments.file_path ?? event.arguments.path ?? event.arguments.command ?? "";
        await this.record(
          identity,
          `start:${event.callId}`,
          {
            eventType: "tool-started",
            assistantTextOffset: assistantText().length,
            callId: event.callId,
            name: event.name,
            target: target.slice(0, 2048),
            arguments: argumentsText.slice(0, 65_536),
            truncated: target.length > 2048 || argumentsText.length > 65_536,
          },
          event.occurredAt,
        );
      } else if (event.type === "tool-finished") {
        await this.record(
          identity,
          `finish:${event.callId}`,
          {
            eventType: "tool-finished",
            callId: event.callId,
            failed: event.failed,
            result: event.result.slice(0, 65_536),
            truncated: event.result.length > 65_536,
          },
          event.occurredAt,
        );
      }
      yield event;
    }
  }

  async questions(
    identity: TurnAttemptIdentity & { messageId: MessageId },
    request: Extract<AgentEvent, { type: "questions-required" }>["request"],
    reply: QuestionReply,
  ): Promise<void> {
    await this.record(identity, `questions:${request.interruptId}`, {
      eventType: "questions-resolved",
      interruptId: request.interruptId,
      questions: request.questions,
      answers: reply.type === "answers" ? reply.values : [],
      cancelled: reply.type === "cancel",
    });
  }
}
