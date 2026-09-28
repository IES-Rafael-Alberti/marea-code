import type { ApprovalRequest } from "./approval.js";
import type { QuestionsRequest } from "./questions.js";
import type { ToolArguments } from "./tool.js";

/**
 * What the interface is told, and what it answers with.
 *
 * The channel is deliberately two-way: an approval and a question stop the
 * agent until the student decides, so they cannot be modelled as output alone.
 * Nothing here is parsed out of the assistant's prose — every event is raised
 * by the runtime that already knows what happened.
 */

export interface SessionContext {
  readonly branch: string;
  readonly cwd: string;
  readonly model: string;
  readonly repositoryUrl: string;
}

export type ParityEvent =
  | { readonly type: "session-started"; readonly context: SessionContext }
  | { readonly type: "assistant-text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-started";
      readonly arguments: ToolArguments;
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: "tool-finished";
      readonly callId: string;
      readonly failed: boolean;
      readonly result: string;
    }
  | { readonly type: "approval-requested"; readonly request: ApprovalRequest }
  | { readonly type: "questions-asked"; readonly request: QuestionsRequest }
  | {
      readonly type: "turn-failed";
      readonly detail: string;
      readonly message: string;
      /** Whether the session can carry on at all after this. */
      readonly recoverable: boolean;
      /** Whether a checkpoint exists to resume the turn from. */
      readonly retryable: boolean;
    }
  | { readonly type: "turn-finished" };

export type ParityDecision =
  | { readonly type: "approve"; readonly interruptId: string }
  | { readonly type: "reject"; readonly interruptId: string; readonly reason: string }
  | { readonly type: "answers"; readonly interruptId: string; readonly values: readonly string[] }
  | { readonly type: "cancel" };
