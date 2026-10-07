import type {
  ModelGatewayRequest,
  ModelGatewayStreamChunk,
  RequestId,
  SocraticMode,
} from "@marea/protocol";

export interface AgentModel {
  readonly kind: "marea-agent-model";
}

export interface AgentCheckpoint {
  readonly kind: "marea-agent-checkpoint";
}

export interface MareaModelGateway {
  stream(request: ModelGatewayRequest, signal: AbortSignal): AsyncIterable<ModelGatewayStreamChunk>;
}

export interface MareaGatewayModelOptions {
  readonly gateway: MareaModelGateway;
  readonly nextRequestId: () => RequestId;
}

export interface LocalCheckpointOptions {
  readonly storageDirectory: string;
  readonly projectDirectory: string;
}

export interface ApprovalTool {
  /** The caller records the actual effect, rather than the result replay. */
  readonly lifecycle?: "external";
  readonly name: string;
  readonly description: string;
  execute(arguments_: Readonly<Record<string, string>>): Promise<string>;
}

export interface ReadOnlyTool {
  readonly name:
    | "marea_read_project"
    | "marea_list_project"
    | "marea_read_skill"
    | "marea_search_project"
    | "marea_glob_project";
  readonly description: string;
  execute(arguments_: Readonly<Record<string, string>>): Promise<string>;
}

export interface AgentRuntimeOptions {
  readonly model: AgentModel;
  readonly checkpoint: AgentCheckpoint;
  readonly approvalTool: ApprovalTool;
  readonly effectTools?: readonly ApprovalTool[];
  readonly systemPrompt: string;
  readonly readOnlyTools?: readonly ReadOnlyTool[];
  readonly readOnly?: boolean;
  readonly questions?: boolean;
  readonly socratic?: { readonly mode: SocraticMode; readonly tools: readonly string[] };
}

export interface MessageTurn {
  readonly kind?: "startup";
  readonly sessionId: string;
  readonly messageId: string;
  /** Durable assistant-text prefix already stored by the caller; empty only for a fresh turn. */
  readonly assistantText?: string;
  readonly text: string;
}

export interface MessageIdentity {
  readonly sessionId: string;
  readonly messageId: string;
  /** Durable assistant-text prefix already stored by the caller; empty only for a fresh turn. */
  readonly assistantText?: string;
}

export type ApprovalDecision =
  | { readonly type: "approve" }
  | { readonly type: "reject"; readonly reason: string }
  | {
      readonly type: "amend";
      readonly arguments: Readonly<Record<string, string>>;
    };

export interface ApprovalTurn {
  readonly sessionId: string;
  readonly messageId: string;
  readonly reviewId: string;
  readonly toolName?: string;
  /** Durable assistant-text prefix already stored by the caller. */
  readonly assistantText?: string;
  readonly decision: ApprovalDecision;
}

export type AgentRecovery =
  | {
      readonly type: "pending-approval";
      /** Canonical full assistant text for the turn, independent of the replay cursor. */
      readonly assistantText: string;
      readonly events: readonly AgentEvent[];
    }
  | {
      readonly type: "completed";
      /** Canonical full assistant text for the turn, independent of the replay cursor. */
      readonly assistantText: string;
      readonly events: readonly AgentEvent[];
    }
  | {
      readonly type: "in-progress";
      /** Canonical full assistant text durably checkpointed before the interrupted graph step. */
      readonly assistantText: string;
      readonly events: readonly AgentEvent[];
    }
  | {
      readonly type: "cancelled";
      readonly assistantText: string;
      readonly events: readonly AgentEvent[];
    };

export interface ToolStartedEvent {
  readonly occurredAt?: string;
  readonly type: "tool-started";
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, string>>;
}

export interface ToolFinishedEvent {
  readonly occurredAt?: string;
  readonly type: "tool-finished";
  readonly callId: string;
  readonly failed: boolean;
  readonly result: string;
}

export type AgentEvent =
  | { readonly type: "assistant-text-delta"; readonly text: string }
  | ToolStartedEvent
  | ToolFinishedEvent
  | {
      readonly type: "tool-approval-required";
      readonly reviewId: string;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, string>>;
      readonly description: string;
      readonly allowedDecisions: readonly ["approve", "amend", "reject"];
    }
  | {
      readonly type: "tool-approval-submitted";
      readonly decision: ApprovalDecision["type"];
    }
  | { readonly type: "turn-completed" }
  | { readonly type: "turn-cancelled" };

export interface AgentRuntime {
  /**
   * Reconstructs a turn from the LangGraph checkpoint. Text events contain only the suffix after
   * the verified `assistantText` prefix; the recovery's `assistantText` contains the canonical full
   * text. A coordinator that persists every delta must pass that exact persisted text on retry.
   */
  recoverMessage(turn: MessageIdentity): Promise<AgentRecovery | null>;
  streamMessage(turn: MessageTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resumeApproval(turn: ApprovalTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export type AgentAdapterErrorCode =
  | "invalid-runtime-dependency"
  | "invalid-checkpoint-state"
  | "invalid-session-id"
  | "invalid-message-id"
  | "invalid-replay-prefix"
  | "approval-not-pending"
  | "approval-review-mismatch"
  | "approval-message-mismatch"
  | "upstream-contract-changed"
  | "model-stream-failed"
  | "upstream-execution-failed";

export class AgentAdapterError extends Error {
  readonly code: AgentAdapterErrorCode;

  constructor(code: AgentAdapterErrorCode, message: string) {
    super(message);
    this.name = "AgentAdapterError";
    this.code = code;
  }
}

export interface ModelStreamFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * The model gateway reported a failed stream. Unlike prose, this keeps the
 * server's code, message and retryable flag, so the interface can present an
 * honest failure instead of a generic one.
 */
export class ModelStreamError extends AgentAdapterError {
  readonly streamCode: string;
  readonly streamMessage: string;
  readonly streamRetryable: boolean;

  constructor(failure: ModelStreamFailure) {
    super("model-stream-failed", "The Marea model gateway reported a failed stream.");
    this.name = "ModelStreamError";
    this.streamCode = failure.code;
    this.streamMessage = failure.message;
    this.streamRetryable = failure.retryable;
  }
}

/** A safe, expected read rejection that the model can correct without aborting the turn. */
export class ReadOnlyToolInputError extends Error {}
