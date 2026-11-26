const maximumDetailLength = 300;

/**
 * Operator-private description of a failure: its name and error code, and optionally its message.
 * Callers that may see parser or credential errors omit the message, because a parser can quote the
 * text it rejected. The result is bounded and never an object, a stack or a cause chain.
 */
export function describeError(error: unknown, includeMessage = true): string {
  if (!(error instanceof Error)) return typeof error;
  const code = "code" in error && typeof error.code === "string" ? ` ${error.code}` : "";
  const message = includeMessage && error.message !== "" ? `: ${error.message}` : "";
  return `${error.name}${code}${message}`.slice(0, maximumDetailLength);
}
