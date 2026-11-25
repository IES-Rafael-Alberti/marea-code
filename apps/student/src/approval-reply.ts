import type { ApprovalDecision, ApprovalReply, StoredApproval } from "./contracts.js";

export interface ResolvedReply {
  readonly decision: ApprovalDecision;
  readonly reason: string | undefined;
  /** The student approved this action and every remaining action of its batch. */
  readonly remaining: boolean;
}

/** One shape for a fresh reply from the interface or a decision stored before a restart. */
export function resolvedReply(reply: ApprovalReply | StoredApproval): ResolvedReply {
  if (typeof reply === "string") return { decision: reply, reason: undefined, remaining: false };
  return {
    decision: reply.decision,
    reason: "reason" in reply ? reply.reason : undefined,
    remaining: "remaining" in reply,
  };
}
