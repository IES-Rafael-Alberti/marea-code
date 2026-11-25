/**
 * Tool results travel to the gateway as single messages of 1..65,536 characters. Larger
 * results would fail the whole request, and DeepAgents' own eviction (above 80,000
 * characters) points the model at a state file it cannot read, so the adapter bounds every
 * result it returns and tells the model exactly what was left out.
 */
export const TOOL_RESULT_CHARACTERS = 60_000;

export function boundToolResult(result: string): string {
  if (result.length === 0) return "(The tool returned no output.)";
  if (result.length <= TOOL_RESULT_CHARACTERS) return result;
  return `${result.slice(0, TOOL_RESULT_CHARACTERS)}\n[Marea truncated this tool result: ${String(result.length - TOOL_RESULT_CHARACTERS)} of ${String(result.length)} characters were omitted. Ask for a smaller range or a narrower command to see the rest.]`;
}
