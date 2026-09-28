import type { StableTurnIdentity } from "./session-turn-executor.js";

import type { TeacherActivityOptions } from "./teacher-activity.js";

/** Durable, bounded progress snapshots; terminal messages remain evaluation evidence. */
export class TurnProgress {
  private last = -Infinity;
  private sending = false;
  private unavailable = false;
  constructor(
    private readonly options: TeacherActivityOptions & {
      readonly liveProgress?: boolean | undefined;
    },
    private readonly identity: StableTurnIdentity,
  ) {}
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
      `progress:${this.identity.messageId}:${String(text.length)}`,
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
