import type { ApprovalDecision } from "./contracts.js";

/** An empty rejection reason would become an empty tool message, which the gateway refuses. */
export function rejectionMessage(reason: string): string {
  return reason.trim().length === 0 ? "The student rejected this action." : reason;
}

export function toUpstreamDecision(decision: ApprovalDecision, toolName: string) {
  if (decision.type === "approve") {
    return { type: "approve" as const };
  }
  if (decision.type === "reject") {
    return { type: "reject" as const, message: rejectionMessage(decision.reason) };
  }
  return {
    type: "edit" as const,
    editedAction: { name: toolName, args: { ...decision.arguments } },
  };
}
