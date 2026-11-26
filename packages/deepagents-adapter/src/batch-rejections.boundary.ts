import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import * as z from "zod";

import type { ApprovalDecision } from "./contracts.js";
import { rejectionMessage, toUpstreamDecision } from "./approval-decision.js";
import { approvalContractChanged } from "./approval-state.boundary.js";

interface PendingAction {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, string>>;
}

/**
 * LangChain's approval middleware treats a rejection as rejecting the whole batch: approved calls
 * of the same message are dropped. Marea lets the student decide each action, so in a batch that
 * mixes decisions every action is resumed as approved and each rejected call is answered here, by
 * its call id, with the student's reason; the tool itself never runs.
 */
export function createBatchRejections() {
  const rejected = new Map<string, string>();
  return {
    middleware: createMiddleware({
      name: "MareaBatchRejections",
      wrapToolCall: (request, handler) => {
        const id = z.string().parse(request.toolCall.id);
        const reason = rejected.get(id);
        if (reason === undefined) return handler(request);
        rejected.delete(id);
        return new ToolMessage({ tool_call_id: id, name: request.toolCall.name, content: reason });
      },
    }),
    /** The resume decisions for upstream; records the rejected call ids of a mixed batch. */
    plan(
      state: unknown,
      actions: readonly PendingAction[],
      decisions: readonly ApprovalDecision[],
    ) {
      const pairs = actions.map((action, index) => {
        const decision = decisions[index];
        if (decision === undefined) throw approvalContractChanged();
        return { action, decision };
      });
      if (decisions.length > actions.length) throw approvalContractChanged();
      const mixed =
        decisions.some((decision) => decision.type === "reject") &&
        decisions.some((decision) => decision.type !== "reject");
      if (!mixed)
        return pairs.map(({ action, decision }) => toUpstreamDecision(decision, action.toolName));
      return withCallIds(state, pairs).map(({ action, decision, id }) => {
        if (decision.type !== "reject") return toUpstreamDecision(decision, action.toolName);
        rejected.set(id, rejectionMessage(decision.reason));
        return { type: "approve" as const };
      });
    },
  };
}

const callSchema = z.object({ id: z.string().min(1), name: z.string(), args: z.unknown() });

/** Each pending action with its call id, matched in order by tool and identical arguments. */
function withCallIds<T extends { readonly action: PendingAction }>(
  state: unknown,
  pairs: readonly T[],
): readonly (T & { readonly id: string })[] {
  const values = z
    .object({ values: z.object({ messages: z.array(z.unknown()) }).loose() })
    .loose()
    .parse(state).values.messages;
  const message = values
    .filter((candidate): candidate is AIMessage => AIMessage.isInstance(candidate))
    .at(-1);
  const calls = (message?.tool_calls ?? []).map((call) => callSchema.parse(call));
  const used = new Set<string>();
  return pairs.map((pair) => {
    const match = calls.find(
      (call) =>
        !used.has(call.id) &&
        call.name === pair.action.toolName &&
        JSON.stringify(call.args) === JSON.stringify(pair.action.arguments),
    );
    if (match === undefined) throw approvalContractChanged();
    used.add(match.id);
    return { ...pair, id: match.id };
  });
}
