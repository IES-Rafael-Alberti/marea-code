import * as z from "zod";

import { AgentAdapterError, type AgentEvent } from "./contracts.js";

/** One interrupt may ask about several actions of the same model message, in call order. */
export const approvalInterruptSchema = z.object({
  id: z.string().min(1),
  value: z.object({
    actionRequests: z
      .array(
        z.object({
          name: z.string().min(1),
          args: z.record(z.string(), z.string()),
          description: z.string().min(1),
        }),
      )
      .min(1),
    reviewConfigs: z
      .array(
        z.object({
          actionName: z.string().min(1),
          allowedDecisions: z.array(z.enum(["approve", "edit", "reject"])),
        }),
      )
      .min(1),
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

type ApprovalAction = ApprovalEvent["actions"][number];

export type ApprovalEvent = Extract<AgentEvent, { readonly type: "tool-approval-required" }>;

export function assertPendingReview(
  input: unknown,
  reviewId: string,
  toolName: string,
  messageId: string,
  decisions = 1,
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
  const event = approvalEventFor(interrupt);
  if (event.toolName !== toolName) {
    throw approvalContractChanged();
  }
  if (event.actions.length !== decisions) {
    throw new AgentAdapterError(
      "approval-review-mismatch",
      "Every pending action needs exactly one decision.",
    );
  }
}

/** The approval that a checkpoint is waiting for; its shape was checked before resuming. */
export function pendingApproval(input: unknown): ApprovalEvent {
  const [interrupt] = pendingStateSchema.parse(input).tasks.flatMap((task) => task.interrupts) as [
    z.infer<typeof approvalInterruptSchema>,
  ];
  return approvalEventFor(interrupt);
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
  const { actionRequests, reviewConfigs } = interrupt.value;
  // Each action is reviewed by the configuration of its own tool, found by name.
  const actions = actionRequests.map((request, index) => {
    const review = reviewConfigs.find((config) => config.actionName === request.name);
    if (
      review === undefined ||
      !review.allowedDecisions.includes("approve") ||
      !review.allowedDecisions.includes("reject")
    )
      throw approvalContractChanged();
    return Object.freeze({
      index,
      toolName: request.name,
      arguments: Object.freeze({ ...request.args }),
      description: request.description,
    });
  });
  const [first] = actions as [ApprovalAction, ...ApprovalAction[]];
  return {
    type: "tool-approval-required",
    reviewId: interrupt.id,
    toolName: first.toolName,
    arguments: first.arguments,
    description: first.description,
    allowedDecisions: ["approve", "amend", "reject"],
    actions: Object.freeze(actions),
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
