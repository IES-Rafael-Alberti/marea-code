import { randomUUID } from "node:crypto";

import type { AgentEvent } from "./contracts.js";

export type ToolLifecycleEvent = Extract<
  AgentEvent,
  { readonly type: "tool-started" } | { readonly type: "tool-finished" }
>;

/**
 * Reports one tool execution around its implementation. The call id is
 * minted here so start and finish pair up without trusting upstream ids;
 * arguments are copied so later stages cannot rewrite what the model sent.
 */
export function observeExecution(
  name: string,
  execute: (input: Readonly<Record<string, string>>) => Promise<string>,
  report: (event: ToolLifecycleEvent) => void,
): (input: Readonly<Record<string, string>>) => Promise<string> {
  return async (input) => {
    const callId = randomUUID();
    const call = { arguments: Object.freeze({ ...input }), callId, name };
    report({ ...call, type: "tool-started", occurredAt: new Date().toISOString() });
    try {
      const result = await execute(input);
      report({
        callId,
        failed: false,
        result,
        type: "tool-finished",
        occurredAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      report({
        callId,
        failed: true,
        result: error instanceof Error ? error.message : "The tool failed without an error.",
        type: "tool-finished",
        occurredAt: new Date().toISOString(),
      });
      throw error;
    }
  };
}
