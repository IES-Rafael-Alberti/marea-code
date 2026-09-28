import type { OperationRequest, OperationTurn } from "./operation-contracts.js";
import type { TurnFailureInfo } from "@marea/student-tui";
import type {
  QuestionRequest,
  ToolFinishedEvent,
  ToolStartedEvent,
} from "@marea/deepagents-adapter";
import type {
  AppendRunEventsRequest,
  AppendRunEventsResponse,
  ApprovalId,
  CapabilitiesRequest,
  CapabilitiesResponse,
  CanonicalRunEvent,
  ClientSessionId,
  ClassBootstrapRequest,
  ClassBootstrapResponse,
  CloseRunRequest,
  CloseRunResponse,
  CredentialLoginRequest,
  CredentialLoginResponse,
  EnrollStudentRequest,
  EnrollStudentResponse,
  EventId,
  IdempotencyKey,
  InvitationCode,
  OpenRunRequest,
  OpenRunResponse,
  RequestId,
  RenewRunLeaseRequest,
  RenewRunLeaseResponse,
  RunId,
  RunToken,
  RunSkillRequest,
  RunSkillResponse,
  SessionToken,
  Sha256Digest,
  SnapshotId,
  StudentRunSnapshot,
} from "@marea/protocol";

export interface CredentialStore {
  clear(): Promise<void>;
  load(): Promise<SessionToken | null>;
  save(token: SessionToken): Promise<void>;
}

export interface IdSource {
  readonly approvalEffect: (approvalId: ApprovalId) => string;
  readonly attempt: () => string;
  readonly clientSession: () => ClientSessionId;
  readonly event: () => EventId;
  readonly idempotency: () => IdempotencyKey;
  readonly request: () => RequestId;
}

export interface Clock {
  now(): string;
}

export type AuthenticationInput =
  | {
      readonly kind: "enroll";
      readonly invitationCode: InvitationCode;
      readonly displayName: string;
      readonly login: string;
      readonly password: string;
    }
  | {
      readonly kind: "login";
      readonly login: string;
      readonly password: string;
    };

export type AuthenticationReason = "missing" | "rejected";
export type ApprovalDecision = "approved" | "rejected";
export type ApprovalReply =
  ApprovalDecision | { readonly decision: "rejected"; readonly reason: string };
export type QuestionReply =
  { readonly type: "answers"; readonly values: readonly string[] } | { readonly type: "cancel" };
export interface AgentQuestionTurn extends Omit<AgentMessageTurn, "text"> {
  readonly request: QuestionRequest;
  readonly values: readonly string[];
}

export interface TurnAttemptIdentity {
  readonly attemptId: string;
  readonly messageId: string;
}

export interface ApprovalPrompt extends TurnAttemptIdentity {
  readonly toolName?: string;
  readonly arguments?: Readonly<Record<string, string>>;
  readonly approvalId: ApprovalId;
  readonly content: string;
  readonly path: string;
  readonly summary: string;
}

export type StudentViewEvent =
  | (TurnAttemptIdentity & { readonly type: "thinking" })
  | (TurnAttemptIdentity & { readonly type: "assistant-text"; readonly text: string })
  | (TurnAttemptIdentity & {
      readonly type: "tool-started";
      readonly callId: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, string>>;
    })
  | (TurnAttemptIdentity & {
      readonly type: "tool-finished";
      readonly callId: string;
      readonly failed: boolean;
      readonly result: string;
    })
  | (TurnAttemptIdentity & { readonly type: "turn-cancelled" })
  | (TurnAttemptIdentity & { readonly type: "turn-completed" });

export interface StudentInterface {
  authenticate(reason: AuthenticationReason): Promise<AuthenticationInput>;
  confirmWrite(prompt: ApprovalPrompt): Promise<ApprovalReply>;
  askQuestions?(request: QuestionRequest & TurnAttemptIdentity): Promise<QuestionReply>;
  present(event: StudentViewEvent): void;
}

export type AuthenticationResult<T> =
  { readonly authenticated: true; readonly value: T } | { readonly authenticated: false };

/** A turn cannot start or continue because no active run exists. */
export class NoActiveRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoActiveRunError";
  }
}

export type { TurnFailureInfo };

/**
 * A turn attempt failed after persisting `prefix` of assistant text. The
 * classifier reads the prefix length and the cause; prose is never parsed.
 */
export class TurnAttemptFailed extends Error {
  readonly prefix: string;
  declare readonly cause: Error;

  constructor(prefix: string, cause: Error) {
    super("The student turn attempt failed.");
    this.name = "TurnAttemptFailed";
    this.prefix = prefix;
    this.cause = cause;
  }
}

export interface StudentServer {
  heartbeat?(token: RunToken): Promise<void>;
  readSkill(token: RunToken, request: RunSkillRequest): Promise<RunSkillResponse>;
  appendRunEvents(
    token: RunToken,
    request: AppendRunEventsRequest,
  ): Promise<AppendRunEventsResponse>;
  bootstrap(
    token: SessionToken,
    request: ClassBootstrapRequest,
  ): Promise<AuthenticationResult<ClassBootstrapResponse>>;
  capabilities(request: CapabilitiesRequest): Promise<CapabilitiesResponse>;
  closeRun(token: RunToken, request: CloseRunRequest): Promise<CloseRunResponse>;
  closeRunAuthenticated(token: SessionToken, request: CloseRunRequest): Promise<CloseRunResponse>;
  enroll(request: EnrollStudentRequest): Promise<EnrollStudentResponse>;
  login(request: CredentialLoginRequest): Promise<CredentialLoginResponse>;
  openRun(token: SessionToken, request: OpenRunRequest): Promise<OpenRunResponse>;
  renewLease(token: SessionToken, request: RenewRunLeaseRequest): Promise<RenewRunLeaseResponse>;
}

export interface WorkspaceWrite {
  readonly digest: Sha256Digest;
  readonly operation: "created" | "updated";
  readonly path: string;
}

export interface GuardedWorkspaceWriter {
  writeApproved(
    effectId: string,
    path: string,
    content: string,
    expectedDigest?: Sha256Digest,
  ): Promise<WorkspaceWrite>;
}

export type AgentEvent =
  | (OperationRequest & { readonly type: "operation-approval-required" })
  | { readonly type: "assistant-text-delta"; readonly text: string }
  | { readonly type: "questions-required"; readonly request: QuestionRequest }
  | ToolStartedEvent
  | ToolFinishedEvent
  | {
      readonly type: "write-approval-required";
      readonly approvalId: ApprovalId;
      readonly path: string;
      readonly content: string;
      readonly summary: string;
    }
  | { readonly type: "turn-completed" }
  | { readonly type: "turn-cancelled" };

export interface AgentMessageTurn {
  /** Exact assistant-text prefix already persisted for this turn. */
  readonly assistantText?: string;
  readonly messageId: string;
  readonly runId: RunId;
  readonly snapshot: StudentRunSnapshot;
  readonly text: string;
}

export interface AgentApprovalTurn {
  readonly reason?: string | undefined;
  readonly approvalId: ApprovalId;
  /** Exact assistant-text prefix already persisted for this turn. */
  readonly assistantText?: string;
  readonly content: string;
  readonly decision: ApprovalDecision;
  readonly effect: WorkspaceWrite | null;
  readonly messageId: string;
  readonly path: string;
  readonly runId: RunId;
  readonly snapshot: StudentRunSnapshot;
  readonly summary: string;
}

export interface AgentRuntime {
  resumeOperation?(turn: OperationTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resumeQuestions?(turn: AgentQuestionTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
  streamStartup?(
    turn: Omit<AgentMessageTurn, "text">,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  resumeApproval(turn: AgentApprovalTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
  streamMessage(turn: AgentMessageTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export interface StoredEffect {
  readonly effectId: string;
  readonly result: WorkspaceWrite;
}

export interface StoredApproval {
  readonly reason?: string | undefined;
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
}

export interface StoredPendingApproval {
  readonly approvalId: ApprovalId;
  readonly content: string;
  readonly effectId: string;
  readonly messageId: string;
  readonly path: string;
  readonly summary: string;
}

export interface StoredEvent {
  readonly key: string;
  readonly value: CanonicalRunEvent;
}

export interface StoredDeliveryEnvelope {
  readonly events: readonly StoredEvent[];
}

export interface StoredTurn {
  readonly lastFailure?: TurnFailureInfo | undefined;
  readonly kind?: "startup" | undefined;
  readonly messageId: string;
  readonly state: "started" | "completed" | "cancelled";
  readonly studentText?: string | undefined;
  readonly text?: string | undefined;
}

export interface PendingStudentTurn {
  readonly failure?: TurnFailureInfo | undefined;
  readonly kind?: "startup";
  readonly assistantText: string;
  readonly messageId: string;
  readonly text: string;
}

export type LegacyValue =
  | boolean
  | null
  | number
  | string
  | readonly LegacyValue[]
  | { readonly [key: string]: LegacyValue };

export type StoredRunPhase = "opening" | "active" | "closing" | "closed";
export type StoredCloseReason = "student-exit" | "cancelled" | "composition-failed" | "fatal-error";
export type StoredOpenIntent = OpenRunRequest["intent"];
export const CURRENT_STUDENT_STATE_VERSION = 2 as const;

export interface StoredRun {
  readonly clientSessionId: ClientSessionId;
  readonly closeReason: StoredCloseReason | null;
  readonly closeRequestId: RequestId | null;
  readonly approvals: readonly StoredApproval[];
  readonly effects: readonly StoredEffect[];
  readonly eventKeys: readonly string[];
  readonly leaseExpiresAt?: string | null;
  readonly leaseIssuedAt?: string | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly legacy?: Readonly<Record<string, LegacyValue>> | undefined;
  readonly nextSequence: number;
  readonly openIntent: StoredOpenIntent;
  readonly outbox: readonly StoredEvent[];
  readonly pendingApprovals?: readonly StoredPendingApproval[];
  readonly pendingDelivery?: StoredDeliveryEnvelope | null;
  readonly phase: StoredRunPhase;
  readonly projectDisplayName: string;
  readonly runId: RunId | null;
  readonly runToken: RunToken | null;
  readonly snapshot: StudentRunSnapshot | null;
  readonly snapshotId: SnapshotId | null;
  readonly turns: readonly StoredTurn[];
}

export interface StudentState {
  readonly run: StoredRun | null;
  readonly legacy?: Readonly<Record<string, LegacyValue>> | undefined;
  readonly version: typeof CURRENT_STUDENT_STATE_VERSION;
}

export interface StudentStateStore {
  load(): Promise<StudentState>;
  save(state: StudentState): Promise<void>;
}

export class StoredTurnFailure extends Error {
  constructor(readonly failure: TurnFailureInfo) {
    super("The stored turn requires intervention.");
    this.name = "StoredTurnFailure";
  }
}
