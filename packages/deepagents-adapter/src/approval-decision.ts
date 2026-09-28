import type { ApprovalDecision } from "./contracts.js";

export function toUpstreamDecision(decision: ApprovalDecision, toolName: string) {
  if (decision.type === "approve") {
    return { type: "approve" as const };
  }
  if (decision.type === "reject") {
    return { type: "reject" as const, message: decision.reason };
  }
  return {
    type: "edit" as const,
    editedAction: { name: toolName, args: { ...decision.arguments } },
  };
}
