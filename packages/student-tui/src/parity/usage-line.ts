import type { ConversationUsage } from "../conversation-contracts.js";

/** Token counts in the short form of a status line: 21, 2.4k, 262k, 1.2M. */
export function compactTokens(count: number): string {
  if (count < 1_000) return String(count);
  const [value, unit] = count < 1_000_000 ? [count / 1_000, "k"] : [count / 1_000_000, "M"];
  // Stryker disable next-line EqualityOperator: at exactly 10 both branches write "10".
  return `${value < 10 ? (Math.floor(value * 10) / 10).toString() : Math.floor(value).toString()}${unit}`;
}

/**
 * `↑2.4k ↓21 0.9%/262k`: input and output totals of the session, then how much of the model's
 * context window the latest call used. Without a known window only the totals are shown.
 */
export function usageLine(usage: ConversationUsage): string {
  const totals = `↑${compactTokens(usage.inputTokens)} ↓${compactTokens(usage.outputTokens)}`;
  const window = usage.contextWindowTokens;
  if (window === undefined) return totals;
  const share = ((usage.lastInputTokens / window) * 100).toFixed(1);
  return `${totals} ${share}%/${compactTokens(window)}`;
}
