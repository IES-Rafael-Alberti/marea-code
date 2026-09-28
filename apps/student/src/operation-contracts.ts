import type { ApprovalId } from "@marea/protocol";
import type { AgentMessageTurn, ApprovalDecision } from "./contracts.js";
export type OperationName = "edit_file" | "execute" | "delete";
export interface OperationRequest {
  readonly approvalId: ApprovalId;
  readonly tool: OperationName;
  readonly arguments: Readonly<Record<string, string>>;
  readonly summary: string;
}
export interface OperationTurn extends Omit<AgentMessageTurn, "text">, OperationRequest {
  readonly decision: ApprovalDecision;
  readonly result: string | null;
  readonly reason?: string | undefined;
}
export interface OperationExecutor {
  prepare(request: OperationRequest): Promise<void>;
  execute(request: OperationRequest, signal: AbortSignal): Promise<string>;
}
