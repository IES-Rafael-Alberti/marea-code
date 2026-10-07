import type { SessionTrace } from "@marea/plugin-api";

/** Defense in depth for pasted known keys and common authorization forms in free text. */
export function redactTrace(trace: SessionTrace, secrets: readonly string[]): SessionTrace {
  const text = (value: string) => {
    let result = value;
    for (const secret of secrets)
      if (secret.length > 0) result = result.replaceAll(secret, "[REDACTED]");
    return result
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/giu, "$1 [REDACTED]")
      .replace(/\bsk-(?:or-v1-|lf-)?[A-Za-z0-9_-]{16,}/gu, "[REDACTED]");
  };
  return {
    ...trace,
    spans: trace.spans.map((span) => ({
      ...span,
      input: text(span.input),
      output: text(span.output),
      metadata: Object.fromEntries(
        Object.entries(span.metadata).map(([key, value]) => [
          key,
          typeof value === "string" ? text(value) : value,
        ]),
      ),
    })),
  };
}
