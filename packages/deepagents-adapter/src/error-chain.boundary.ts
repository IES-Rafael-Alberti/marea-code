/**
 * Follows an error's cause chain to its deepest error. LangChain middleware
 * wraps failures while preserving the chain, so a typed root cause only
 * shows at the bottom. Returns null for non-errors. Cycle-safe.
 */
export function deepestCause(
  error: unknown,
  seen: Set<unknown> = new Set<unknown>(),
): Error | null {
  if (!(error instanceof Error) || seen.has(error)) return null;
  seen.add(error);
  const inner = deepestCause(error.cause, seen);
  return inner ?? error;
}
