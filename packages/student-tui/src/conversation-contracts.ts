import type { QuestionReply } from "./question-channel.js";
import type { QuestionsRequest } from "./parity/questions.js";
import type { StudentTuiOutcome } from "./contracts.js";
import type { ParityCopy } from "./parity/copy.js";
import type { SessionContext } from "./parity/events.js";
import type { ToolOutcome } from "./parity/tool.js";

export type ConversationStatus =
  "ready" | "streaming" | "approval" | "questions" | "cancelled" | "failed";

export type TurnFailureKind =
  | "provider-interrupted"
  | "request-failed"
  | "session-unavailable"
  | "session-ended-by-teacher"
  | "session-expired"
  | "unexpected"
  | "deadline-exceeded"
  | "budget-exhausted"
  | "concurrency-limited"
  | "recovery-pending";

export interface TurnFailureInfo {
  readonly code?: string | undefined;
  /** Server-composed or sanitized diagnostic text, or empty when none is safe. */
  readonly detail: string;
  readonly hasPrefix: boolean;
  readonly kind: TurnFailureKind;
  readonly recoverable: boolean;
  readonly retryable: boolean;
}

/**
 * Carries a classified turn failure through a rejected turn operation. The
 * application classifies; the controller only extracts.
 */
export class TurnFailureSignal extends Error {
  readonly failure: TurnFailureInfo;

  constructor(failure: TurnFailureInfo) {
    super("The conversation turn failed.");
    this.name = "TurnFailureSignal";
    this.failure = failure;
  }
}

export type ConversationMessageId = string;

export type ConversationAttemptId = string;

export interface ConversationMessage {
  readonly author: "student" | "marea";
  readonly text: string;
}

export interface ConversationToolStart {
  readonly arguments: Readonly<Record<string, string>>;
  readonly callId: string;
  readonly name: string;
}

export interface ConversationToolFinish {
  readonly callId: string;
  readonly failed: boolean;
  readonly result: string;
}

export interface ConversationToolCall extends ConversationToolStart {
  readonly outcome: ToolOutcome | null;
}

export interface ConversationApproval {
  readonly arguments?: Readonly<Record<string, string>> | undefined;
  readonly approvalId?: string;
  readonly toolName?: string;
  readonly warnings?: readonly string[];
  readonly content?: string;
  readonly path: string;
  readonly summary: string;
  /** Position in a batch of several approvals from one model message. */
  readonly batch?:
    | { readonly position: number; readonly total: number; readonly remaining: readonly string[] }
    | undefined;
}

/** Session token totals and the input of the latest model call, for the `/usage` line. */
export interface ConversationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly lastInputTokens: number;
  readonly contextWindowTokens?: number | undefined;
}

export interface ConversationSnapshot {
  /** Generic internal work; never carries private tool names or reasoning text. */
  readonly activity?: "thinking" | "loadingSkills" | undefined;
  readonly questions?: QuestionsRequest;
  readonly approval: ConversationApproval | null;
  /** Classified failure while status is "failed"; absent otherwise. */
  readonly failure?: TurnFailureInfo | undefined;
  readonly messages: readonly ConversationMessage[];
  /** Set while an automatic retry of a recoverable failure is streaming (1 or 2). */
  readonly automaticRetry?: number | undefined;
  readonly status: ConversationStatus;
  /** Tool rows of the current turn, in execution order. */
  readonly tools?: readonly ConversationToolCall[];
  readonly usage?: ConversationUsage | undefined;
}

export interface ConversationPendingTurn {
  readonly failure?: TurnFailureInfo | undefined;
  readonly kind?: "startup";
  readonly assistantText: string;
  readonly messageId: ConversationMessageId;
  readonly text: string;
}

export type ConversationAction =
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "retry" }
  | { readonly type: "cancel" }
  | { readonly type: "exit" }
  | { readonly type: "approve"; readonly interruptId?: string }
  | { readonly type: "approve-all"; readonly interruptId?: string }
  | { readonly type: "reject"; readonly reason?: string; readonly interruptId?: string }
  | { readonly type: "answers"; readonly interruptId: string; readonly values: readonly string[] };

export type ConversationApprovalDecision =
  | "approved"
  | "rejected"
  | { readonly decision: "rejected"; readonly reason: string }
  /** This action and the remaining actions of its batch. */
  | { readonly decision: "approved"; readonly remaining: true };

export interface ConversationView {
  /** Native views yield all terminal ownership to an external interactive flow. */
  readonly withTerminalSuspended?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly dispose: () => void;
  readonly render: (snapshot: ConversationSnapshot) => void;
  readonly setCopy?: (copy: ConversationCopy) => void;
}

export interface ConversationHistory {
  readonly entries: readonly string[];
  remember(text: string): void;
}

export interface ConversationCopy {
  readonly mouse?: boolean;
  readonly parity: {
    readonly copy: ParityCopy;
    readonly context: SessionContext;
    readonly history?: ConversationHistory | undefined;
    /** Whether the `/usage` line starts visible, and where a change of mind is saved. */
    readonly usage?: ConversationUsagePreference | undefined;
  };
}

export interface ConversationUsagePreference {
  readonly visible: boolean;
  readonly onVisibilityChange?: ((visible: boolean) => void) | undefined;
}

/** What both the controller and the session offer for the turn in progress. */
interface ConversationTurnSurface {
  thinking(
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
    activity?: "thinking" | "loadingSkills",
  ): boolean;
  appendAssistantText(
    text: string,
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): boolean;
  /**
   * Drops the last `discardedLength` characters of the turn's answer: an interrupted answer
   * that Marea is generating again. The new answer then arrives as ordinary text.
   */
  restartAssistantText(
    discardedLength: number,
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): boolean;
  cancel(messageId?: ConversationMessageId, attemptId?: ConversationAttemptId): boolean;
  complete(messageId?: ConversationMessageId, attemptId?: ConversationAttemptId): boolean;
  fail(messageId?: ConversationMessageId, attemptId?: ConversationAttemptId): boolean;
  requestApproval(
    approval: ConversationApproval,
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): Promise<ConversationApprovalDecision>;
  resumeTurn(): boolean;
  /** Replaces the usage the `/usage` line shows; it belongs to the session, not to a turn. */
  reportUsage(usage: ConversationUsage): boolean;
  snapshot(): ConversationSnapshot;
  toolFinished(
    finish: ConversationToolFinish,
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): boolean;
  toolStarted(
    call: ConversationToolStart,
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): boolean;
}

export interface ConversationController extends ConversationTurnSurface {
  dispose(): boolean;
  handle(action: ConversationAction): boolean;
  requestQuestions(
    request: QuestionsRequest,
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): Promise<QuestionReply>;
}

export interface ConversationControllerOptions {
  readonly onMessage: (
    text: string,
    signal: AbortSignal,
    messageId: ConversationMessageId,
    attemptId: ConversationAttemptId,
  ) => Promise<void>;
  readonly onExit: () => void;
  readonly initialTurn?: ConversationPendingTurn | undefined;
  readonly nextMessageId?: (() => ConversationMessageId) | undefined;
  readonly nextAttemptId?: (() => ConversationAttemptId) | undefined;
  /** Automatic retries of a recoverable failure before it is shown; defaults to two. */
  readonly automaticRetries?: number | undefined;
  readonly view: ConversationView;
}

export interface ConversationTuiOptions {
  readonly copy: ConversationCopy;
  readonly onMessage: (
    text: string,
    signal: AbortSignal,
    messageId: ConversationMessageId,
    attemptId: ConversationAttemptId,
  ) => Promise<void>;
  readonly initialTurn?: ConversationPendingTurn | undefined;
  readonly nextMessageId?: (() => ConversationMessageId) | undefined;
  readonly nextAttemptId?: (() => ConversationAttemptId) | undefined;
  readonly onLanguageCommand?:
    | ((
        copy: ConversationCopy,
      ) => ConversationLanguageChange | Promise<ConversationLanguageChange | null> | null)
    | undefined;
}

export interface ConversationLanguageChange {
  readonly copy: ConversationCopy;
  readonly notice?: string | undefined;
}

export interface ConversationTuiSession extends ConversationTurnSurface {
  withTerminalSuspended<T>(operation: () => Promise<T>): Promise<T>;
  readonly outcome: Promise<StudentTuiOutcome>;
  readonly retry?: () => boolean;
  close(): boolean;
  requestQuestions?(
    request: QuestionsRequest,
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): Promise<QuestionReply>;
}

export type ConversationViewFactory = (
  copy: ConversationCopy,
  onAction: (action: ConversationAction) => void,
  onLanguageCommand?: (
    copy: ConversationCopy,
  ) => ConversationLanguageChange | Promise<ConversationLanguageChange | null> | null,
) => Promise<ConversationView>;
