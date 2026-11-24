import type { ConversationSnapshot, TurnFailureInfo } from "./conversation-contracts.js";

/** A recoverable failure is retried this many times before the student sees it. */
const DEFAULT_AUTOMATIC_RETRIES = 2;

/** The retry marker belongs to the attempt in progress; a settled turn does not carry it. */
const SETTLED_STATUSES: ReadonlySet<ConversationSnapshot["status"]> = new Set([
  "ready",
  "failed",
  "cancelled",
]);

export function withoutSettledRetry(snapshot: ConversationSnapshot): ConversationSnapshot {
  return SETTLED_STATUSES.has(snapshot.status)
    ? { ...snapshot, automaticRetry: undefined }
    : snapshot;
}

/** Counts automatic retries of one message; any other attempt starts a fresh allowance. */
export class AutomaticRetries {
  private messageId = "";
  private count = 0;

  constructor(private readonly limit = DEFAULT_AUTOMATIC_RETRIES) {}

  /** The number of the next automatic retry of this failure, or null when none is due. */
  next(messageId: string, failure: TurnFailureInfo | undefined): number | null {
    if (failure?.retryable !== true) return null;
    const count = this.messageId === messageId ? this.count : 0;
    if (count >= this.limit) return null;
    this.messageId = messageId;
    this.count = count + 1;
    return this.count;
  }

  reset(messageId: string): void {
    this.messageId = messageId;
    this.count = 0;
  }
}
