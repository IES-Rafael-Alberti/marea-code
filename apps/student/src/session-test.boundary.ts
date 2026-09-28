/** Settles a turn attempt to its rejection (or its value when it resolves). */
export function captureRejection(attempt: Promise<unknown>): Promise<unknown> {
  return attempt.catch((error: unknown) => error);
}
