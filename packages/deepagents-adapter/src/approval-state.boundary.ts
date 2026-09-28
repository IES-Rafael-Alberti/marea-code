import * as z from "zod";

import { AgentAdapterError, type AgentEvent } from "./contracts.js";

export const approvalInterruptSchema = z.object({
  id: z.string().min(1),
  value: z.object({
    actionRequests: z.tuple([
      z.object({
        name: z.string().min(1),
        args: z.record(z.string(), z.string()),
        description: z.string().min(1),
      }),
    ]),
    reviewConfigs: z.tuple([
      z.object({
        actionName: z.string().min(1),
        allowedDecisions: z.tuple([z.literal("approve"), z.literal("edit"), z.literal("reject")]),
      }),
    ]),
  }),
});

const approvalEnvelopeSchema = z.object({
  __interrupt__: z.tuple([approvalInterruptSchema]).optional(),
});

const pendingStateSchema = z.object({
  tasks: z.array(
    z.object({
      interrupts: z.array(approvalInterruptSchema),
    }),
  ),
});

export type ApprovalEvent = Extract<AgentEvent, { readonly type: "tool-approval-required" }>;

export function assertPendingReview(
  input: unknown,
  reviewId: string,
  toolName: string,
  messageId: string,
): void {
  const parsed = pendingStateSchema.safeParse(input);
  if (!parsed.success) {
    throw approvalContractChanged();
  }
  const interrupts = parsed.data.tasks.flatMap((task) => task.interrupts);
  const [interrupt, ...additionalInterrupts] = interrupts;
  if (interrupt === undefined) {
    throw new AgentAdapterError(
      "approval-not-pending",
      "No tool approval is pending for this session.",
    );
  }
  if (additionalInterrupts.length > 0) {
    throw approvalContractChanged();
  }
  if (interrupt.id !== reviewId) {
    throw new AgentAdapterError(
      "approval-review-mismatch",
      "The pending tool approval does not match this review.",
    );
  }
  const metadata = (input as { readonly metadata?: unknown }).metadata;
  const checkpointMessageId =
    typeof metadata === "object" && metadata !== null && "messageId" in metadata
      ? metadata.messageId
      : undefined;
  if (checkpointMessageId !== messageId) {
    throw new AgentAdapterError(
      "approval-message-mismatch",
      "The pending tool approval does not match this message.",
    );
  }
  if (approvalEventFor(interrupt).toolName !== toolName) {
    throw approvalContractChanged();
  }
}

export function parseApprovalEvent(input: unknown): AgentEvent | null {
  const parsed = approvalEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw approvalContractChanged();
  }
  const interrupts = parsed.data.__interrupt__;
  if (interrupts === undefined) {
    return null;
  }
  const [interrupt] = interrupts;
  return approvalEventFor(interrupt);
}

export function approvalEventFor(
  interrupt: z.infer<typeof approvalInterruptSchema>,
): ApprovalEvent {
  const [request] = interrupt.value.actionRequests;
  const [review] = interrupt.value.reviewConfigs;
  if (request.name !== review.actionName) {
    throw approvalContractChanged();
  }
  return {
    type: "tool-approval-required",
    reviewId: interrupt.id,
    toolName: request.name,
    arguments: Object.freeze({ ...request.args }),
    description: request.description,
    allowedDecisions: ["approve", "amend", "reject"],
  };
}

export function assertRecoveredReview(
  recovered: { readonly approval: ApprovalEvent | null },
  reviewId: string,
  toolName: string,
): void {
  const approval = recovered.approval;
  if (approval === null) {
    throw new AgentAdapterError(
      "approval-not-pending",
      "No tool approval is pending for this session.",
    );
  }
  if (approval.reviewId !== reviewId) {
    throw new AgentAdapterError(
      "approval-review-mismatch",
      "The pending tool approval does not match this review.",
    );
  }
  if (approval.toolName !== toolName) throw approvalContractChanged();
}

export function approvalContractChanged(): AgentAdapterError {
  return new AgentAdapterError(
    "upstream-contract-changed",
    "DeepAgents returned an unsupported approval payload.",
  );
}
