import { ApprovalIdSchema, type ApprovalId } from "@marea/protocol";

import { WriteRequestSchema, type WriteRequest } from "./write-request.js";

export class StudentAgentBridgeError extends Error {}

export function parseApprovalId(reviewId: string): ApprovalId {
  const parsed = ApprovalIdSchema.safeParse(reviewId);
  if (!parsed.success) {
    throw new StudentAgentBridgeError("DeepAgents returned an invalid approval identity.");
  }
  return parsed.data;
}

export function parseWriteRequest(arguments_: Readonly<Record<string, string>>): WriteRequest {
  const parsed = WriteRequestSchema.safeParse(arguments_);
  if (!parsed.success) {
    throw new StudentAgentBridgeError("DeepAgents returned invalid write_file arguments.");
  }
  return parsed.data;
}
