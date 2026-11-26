import type { StableTurnIdentity } from "./session-turn-executor.js";

import type { TeacherActivityOptions } from "./teacher-activity.js";

/** Durable, bounded progress snapshots; terminal messages remain evaluation evidence. */
export class TurnProgress {
  private last = -Infinity;
  private generation = 0;
  private sending = false;
  private unavailable = false;
  constructor(
    private readonly options: TeacherActivityOptions & {
      readonly liveProgress?: boolean | undefined;
    },
    private readonly identity: StableTurnIdentity,
  ) {}
  /** The next snapshot follows a discarded answer and is sent even if it looks the same. */
  restart(): void {
    // Stryker disable next-line AssignmentOperator: any change of the generation gives new keys.
    this.generation += 1;
    this.last = -Infinity;
  }

  async publish(text: string): Promise<void> {
    if (
      this.options.liveProgress !== true ||
      this.unavailable ||
      this.sending ||
      Date.now() - this.last < 250
    )
      return;
    this.last = Date.now();
    await this.options.localSession.appendEvent(
      // A regenerated answer can repeat the length of the one it replaces; it is a new snapshot.
      `progress:${this.identity.messageId}:${this.identity.attemptId}:${String(this.generation)}:${String(text.length)}`,
      (sequence, occurredAt) => ({
        eventType: "assistant-progress",
        eventId: this.options.ids.event(),
        sequence,
        occurredAt,
        messageId: this.identity.messageId,
        content: text.slice(0, 16_384),
        truncated: text.length > 16_384,
      }),
    );
    this.sending = true;
    // A slow dashboard must not pause the student's token stream. Delivery is
    // serialized by the controller; a failed hint remains in the durable outbox.
    void this.options
      .flushOutbox()
      .catch(() => {
        this.unavailable = true;
      })
      .finally(() => {
        this.sending = false;
      });
  }
}
