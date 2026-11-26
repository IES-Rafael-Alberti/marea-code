import type { MessageId } from "@marea/protocol";
import type { IdSource } from "./contracts.js";
import type { LocalSession } from "./local-session.js";
import type { ProjectEvidence } from "./project-evidence.js";

const REASON_LIMIT = 300;

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim().slice(0, REASON_LIMIT);
}

/**
 * Evidence is secondary to the student's work: when Git cannot record it (timeout, a file locked on
 * Windows, a damaged index), the turn continues and the teacher gets a `project-change` event that
 * says the change could not be recorded and why.
 */
export class ResilientProjectEvidence implements ProjectEvidence {
  constructor(
    private readonly inner: ProjectEvidence,
    private readonly localSession: LocalSession,
    private readonly ids: IdSource,
  ) {}

  private async guarded(
    actor: "student" | "agent" | "unknown",
    messageId: MessageId | undefined,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      await this.report(actor, messageId, reasonOf(error));
    }
  }

  private async report(
    actor: "student" | "agent" | "unknown",
    messageId: MessageId | undefined,
    reason: string,
  ): Promise<void> {
    const eventId = this.ids.event();
    const summary = `Marea no ha podido registrar los cambios del proyecto${reason === "" ? "" : `: ${reason}`}`;
    try {
      await this.localSession.appendEvent(`project-change-failed:${eventId}`, (sequence, at) => ({
        eventType: "project-change",
        eventId,
        sequence,
        occurredAt: at,
        actor,
        messageId,
        patch: "",
        summary,
        truncated: true,
      }));
    } catch {
      // Telling the teacher is best effort too: it must not fail the student's turn.
    }
  }

  start(): Promise<void> {
    return this.guarded("student", undefined, () => this.inner.start());
  }

  async context(messageId: MessageId): Promise<string> {
    try {
      // Stryker disable next-line OptionalChaining: a missing method throws a TypeError, which the catch turns into the same empty context.
      return (await this.inner.context?.(messageId)) ?? "";
    } catch {
      return "";
    }
  }

  capture(actor: "student" | "agent" | "unknown", messageId?: MessageId): Promise<void> {
    return this.guarded(actor, messageId, () => this.inner.capture(actor, messageId));
  }

  beginAgent(messageId: MessageId): Promise<void> {
    return this.guarded("agent", messageId, () => this.inner.beginAgent(messageId));
  }
}
