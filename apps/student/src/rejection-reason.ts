/**
 * The student's reason for rejecting an action, or the default when they typed none. The terminal
 * sends an empty reason for a bare rejection, and an empty tool message poisons the conversation.
 */
export function rejectionReason(reason: string | undefined, fallback: string): string {
  return reason === undefined || reason.trim().length === 0 ? fallback : reason;
}
