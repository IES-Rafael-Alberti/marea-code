import type { ProjectEvidence } from "./project-evidence.js";
import type { OperationExecutor } from "./operation-contracts.js";
import { ModelStreamError } from "@marea/deepagents-adapter";
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import {
  ApprovalIdSchema,
  AppendRunEventsRequestSchema,
  CapabilitiesRequestSchema,
  ClassBootstrapRequestSchema,
  ClientSessionIdSchema,
  CloseRunRequestSchema,
  CredentialLoginRequestSchema,
  EnrollStudentRequestSchema,
  EventIdSchema,
  IdempotencyKeySchema,
  InvitationCodeSchema,
  OpenRunRequestSchema,
  ProtocolVersionSchema,
  RequestIdSchema,
  RenewRunLeaseRequestSchema,
  RunIdSchema,
  RunTokenSchema,
  ServerCapabilitySchema,
  SessionTokenSchema,
  type AppendRunEventsRequest,
  type AppendRunEventsResponse,
  type CapabilitiesRequest,
  type CapabilitiesResponse,
  type CanonicalRunEvent,
  type ClassBootstrapRequest,
  type ClassBootstrapResponse,
  type CloseRunRequest,
  type CloseRunResponse,
  type CredentialLoginRequest,
  type CredentialLoginResponse,
  type EnrollStudentRequest,
  type EnrollStudentResponse,
  type OpenRunRequest,
  type OpenRunResponse,
  type RenewRunLeaseResponse,
  type RunToken,
  type SessionToken,
} from "@marea/protocol";

import type {
  AgentEvent,
  AgentApprovalTurn,
  AgentMessageTurn,
  AgentRuntime,
  ApprovalDecision,
  ApprovalPrompt,
  AuthenticationReason,
  Clock,
  CredentialStore,
  GuardedWorkspaceWriter,
  IdSource,
  StudentInterface,
  StudentServer,
  StudentState,
  StudentStateStore,
  StudentViewEvent,
  WorkspaceWrite,
} from "./contracts.js";
import { CURRENT_STUDENT_STATE_VERSION } from "./contracts.js";
import { LocalSession } from "./local-session.js";
import { StudentSessionController } from "./session-controller.js";
import { DIGEST, snapshot } from "./student-snapshot.fixture.js";

export { DIGEST } from "./student-snapshot.fixture.js";

export const SESSION_TOKEN = SessionTokenSchema.parse("s".repeat(32));
export const RUN_TOKEN = RunTokenSchema.parse("r".repeat(32));
const INVITATION = InvitationCodeSchema.parse("invite-code-1234");
export const APPROVAL_ID = ApprovalIdSchema.parse("approval:1");

export class MemoryCredentialStore implements CredentialStore {
  token: SessionToken | null = null;
  clears = 0;

  async clear(): Promise<void> {
    this.clears += 1;
    this.token = null;
  }

  async load(): Promise<SessionToken | null> {
    return this.token;
  }

  async save(token: SessionToken): Promise<void> {
    this.token = token;
  }
}

export class MemoryStateStore implements StudentStateStore {
  state: StudentState = { run: null, version: CURRENT_STUDENT_STATE_VERSION };
  saves = 0;

  async load(): Promise<StudentState> {
    return this.state;
  }

  async save(state: StudentState): Promise<void> {
    this.saves += 1;
    this.state = state;
  }
}

export class FixtureIds implements IdSource {
  count = 0;

  approvalEffect(approvalId: Parameters<IdSource["approvalEffect"]>[0]): string {
    return `effect:${approvalId.slice("approval:".length)}`;
  }

  attempt(): string {
    return `attempt:${String(++this.count)}`;
  }

  clientSession() {
    return ClientSessionIdSchema.parse(`client:${String(++this.count)}`);
  }

  event() {
    return EventIdSchema.parse(`event:${String(++this.count)}`);
  }

  idempotency() {
    return IdempotencyKeySchema.parse(`idempotency:${String(++this.count)}`);
  }

  request() {
    return RequestIdSchema.parse(`request:${String(++this.count)}`);
  }
}

export const FIXTURE_CLOCK: Clock = Object.freeze({ now: () => "2026-09-03T10:00:00.000Z" });

export class FixtureInterface implements StudentInterface {
  readonly authenticationReasons: AuthenticationReason[] = [];
  readonly events: StudentViewEvent[] = [];
  readonly prompts: {
    readonly approvalId: string;
    readonly attemptId: string;
    readonly messageId: string;
    readonly path: string;
    readonly summary: string;
  }[] = [];
  approvals = 0;
  authKind: "enroll" | "login" = "enroll";
  decision: ApprovalDecision = "approved";

  async authenticate(reason: AuthenticationReason) {
    this.authenticationReasons.push(reason);
    return this.authKind === "enroll"
      ? {
          kind: "enroll" as const,
          invitationCode: INVITATION,
          displayName: "Student One",
          login: "student.one",
          password: "strong-password",
        }
      : {
          kind: "login" as const,
          login: "student.one",
          password: "strong-password",
        };
  }

  async confirmWrite(prompt: ApprovalPrompt): Promise<import("./contracts.js").ApprovalReply> {
    this.approvals += 1;
    this.prompts.push(prompt);
    return this.decision;
  }

  present(event: StudentViewEvent): void {
    this.events.push(event);
  }
}

export class FixtureServer implements StudentServer {
  readSkill(): ReturnType<StudentServer["readSkill"]> {
    return Promise.reject(new Error("No skill content configured in this fixture."));
  }
  readonly appendRequests: AppendRunEventsRequest[] = [];
  readonly events = new Map<number, CanonicalRunEvent>();
  readonly openFingerprints = new Map<string, string>();
  readonly openRequests: OpenRunRequest[] = [];
  authenticatedCloseCalls = 0;
  bootstrapCalls = 0;
  closeCalls = 0;
  enrolled = 0;
  loggedIn = 0;
  renewCalls = 0;
  active = false;
  rejectStored = false;
  loseNextAppendResponse = false;
  loseNextCloseResponse = false;
  loseNextOpenResponse = false;

  async appendRunEvents(
    _token: RunToken,
    request: AppendRunEventsRequest,
  ): Promise<AppendRunEventsResponse> {
    AppendRunEventsRequestSchema.parse(request);
    this.appendRequests.push(request);
    for (const event of request.events) this.events.set(event.sequence, event);
    if (this.loseNextAppendResponse) {
      this.loseNextAppendResponse = false;
      throw new ModelStreamError({
        code: "unavailable",
        message: "response lost",
        retryable: true,
      });
    }
    return {
      kind: "run-events-acknowledged",
      protocolVersion: "0.1",
      requestId: request.requestId,
      highestDurableSequence: Math.max(0, ...this.events.keys()),
    };
  }

  async bootstrap(
    _token: SessionToken,
    request: ClassBootstrapRequest,
  ): Promise<
    | { readonly authenticated: true; readonly value: ClassBootstrapResponse }
    | { readonly authenticated: false }
  > {
    ClassBootstrapRequestSchema.parse(request);
    this.bootstrapCalls += 1;
    if (this.rejectStored) {
      this.rejectStored = false;
      return { authenticated: false };
    }
    return {
      authenticated: true,
      value: {
        kind: "class-bootstrapped",
        protocolVersion: "0.1",
        requestId: request.requestId,
        principal: { role: "student", displayName: "Student One" },
        classroom: { displayName: "Class One" },
        modelAlias: "marea",
        activeRun: this.active
          ? {
              runId: RunIdSchema.parse("run:1"),
              projectDisplayName: "Project One",
              state: "active",
            }
          : null,
      },
    };
  }

  async capabilities(request: CapabilitiesRequest): Promise<CapabilitiesResponse> {
    CapabilitiesRequestSchema.parse(request);
    return {
      requestId: request.requestId,
      serverVersion: "1.0.0",
      supportedProtocolVersions: [
        ProtocolVersionSchema.parse(request.supportedProtocolVersions[0]),
      ],
      capabilities: [
        "marea.auth.student",
        "marea.class.bootstrap",
        "marea.runs.events",
        "marea.runs.lifecycle",
        "marea.runs.exact-resume",
        "marea.runs.authenticated-close",
        "marea.runs.lease-renewal",
      ].map((value) => ServerCapabilitySchema.parse(value)),
    };
  }

  async closeRun(token: RunToken, request: CloseRunRequest): Promise<CloseRunResponse> {
    RunTokenSchema.parse(token);
    CloseRunRequestSchema.parse(request);
    this.closeCalls += 1;
    return this.closeResponse(request);
  }

  async closeRunAuthenticated(
    token: SessionToken,
    request: CloseRunRequest,
  ): Promise<CloseRunResponse> {
    SessionTokenSchema.parse(token);
    CloseRunRequestSchema.parse(request);
    this.authenticatedCloseCalls += 1;
    this.closeCalls += 1;
    return this.closeResponse(request);
  }

  private closeResponse(request: CloseRunRequest): CloseRunResponse {
    const alreadyClosed = !this.active;
    if (!alreadyClosed) {
      const sequence = Math.max(0, ...this.events.keys()) + 1;
      this.events.set(sequence, {
        eventId: EventIdSchema.parse("event:server-closed"),
        eventType: "run-closed",
        occurredAt: FIXTURE_CLOCK.now(),
        reason: request.reason,
        sequence,
      });
    }
    this.active = false;
    if (this.loseNextCloseResponse) {
      this.loseNextCloseResponse = false;
      throw new Error("response lost");
    }
    return {
      protocolVersion: "0.1",
      requestId: request.requestId,
      runId: RunIdSchema.parse("run:1"),
      state: "closed",
      alreadyClosed,
    };
  }

  async renewLease(
    _token: SessionToken,
    request: import("@marea/protocol").RenewRunLeaseRequest,
  ): Promise<RenewRunLeaseResponse> {
    RenewRunLeaseRequestSchema.parse(request);
    this.renewCalls += 1;
    return {
      kind: "run-lease-renewed",
      lease: {
        expiresAt: "2026-09-03T10:10:00.000Z",
        issuedAt: FIXTURE_CLOCK.now(),
        runId: RunIdSchema.parse("run:1"),
        token: RUN_TOKEN,
      },
      protocolVersion: "0.1",
      requestId: request.requestId,
    };
  }

  async enroll(request: EnrollStudentRequest): Promise<EnrollStudentResponse> {
    EnrollStudentRequestSchema.parse(request);
    this.enrolled += 1;
    return {
      kind: "student-invitation-enrolled",
      protocolVersion: "0.1",
      requestId: request.requestId,
      principal: { role: "student", displayName: request.displayName },
      session: {
        token: SESSION_TOKEN,
        issuedAt: "2026-09-03T10:00:00.000Z",
        expiresAt: "2026-09-04T10:00:00.000Z",
      },
    };
  }

  async login(request: CredentialLoginRequest): Promise<CredentialLoginResponse> {
    CredentialLoginRequestSchema.parse(request);
    this.loggedIn += 1;
    return {
      kind: "credential-authenticated",
      protocolVersion: "0.1",
      requestId: request.requestId,
      principal: { role: "student", displayName: "Student One" },
      session: {
        token: SESSION_TOKEN,
        issuedAt: "2026-09-03T10:00:00.000Z",
        expiresAt: "2026-09-04T10:00:00.000Z",
      },
    };
  }

  async openRun(_token: SessionToken, request: OpenRunRequest): Promise<OpenRunResponse> {
    OpenRunRequestSchema.parse(request);
    this.openRequests.push(request);
    const fingerprint = JSON.stringify({
      clientSessionId: request.clientSessionId,
      intent: request.intent,
      project: request.project,
    });
    const previous = this.openFingerprints.get(request.idempotencyKey);
    if (previous !== undefined && previous !== fingerprint) throw new Error("request.conflict");
    const firstAttempt = previous === undefined;
    if (firstAttempt) this.openFingerprints.set(request.idempotencyKey, fingerprint);
    if (firstAttempt && request.intent.kind === "new") this.events.clear();
    if (firstAttempt && !this.events.has(1)) {
      this.events.set(1, {
        eventId: EventIdSchema.parse("event:server-activated"),
        eventType: "run-activated",
        occurredAt: FIXTURE_CLOCK.now(),
        sequence: 1,
      });
    }
    this.active = true;
    const response: OpenRunResponse = {
      protocolVersion: "0.1",
      requestId: request.requestId,
      highestDurableSequence: Math.max(...this.events.keys()),
      lease: {
        runId: RunIdSchema.parse("run:1"),
        token: RUN_TOKEN,
        issuedAt: "2026-09-03T10:00:00.000Z",
        expiresAt: "2026-09-04T10:00:00.000Z",
      },
      snapshot,
    };
    if (this.loseNextOpenResponse) {
      this.loseNextOpenResponse = false;
      throw new Error("open response lost");
    }
    return response;
  }
}

export class FixtureAgent implements AgentRuntime {
  readonly approvalTurns: AgentApprovalTurn[] = [];
  readonly messageTurns: AgentMessageTurn[] = [];
  messages = 0;
  resumes = 0;
  cancellation = false;

  async *streamMessage(_turn: AgentMessageTurn, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.messageTurns.push(_turn);
    this.messages += 1;
    if (this.cancellation) {
      yield { type: "turn-cancelled" };
      return;
    }
    yield { type: "assistant-text-delta", text: "I will help. " };
    yield {
      type: "write-approval-required",
      approvalId: APPROVAL_ID,
      path: "notes.txt",
      content: "New notes",
      summary: "Create notes.txt",
    };
  }

  async *resumeApproval(_turn: AgentApprovalTurn, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.approvalTurns.push(_turn);
    this.resumes += 1;
    yield { type: "assistant-text-delta", text: "Done." };
    yield { type: "turn-completed" };
  }
}
export class FixtureWorkspace implements GuardedWorkspaceWriter {
  readonly calls: { readonly content: string; readonly effectId: string; readonly path: string }[] =
    [];
  writes = 0;

  async writeApproved(effectId: string, path: string, content: string): Promise<WorkspaceWrite> {
    this.writes += 1;
    this.calls.push({ content, effectId, path });
    return { digest: DIGEST, operation: "created", path };
  }
}
export function createFixtureController(
  options: {
    readonly agent?: FixtureAgent;
    readonly operations?: OperationExecutor;
    readonly evidence?: ProjectEvidence;
    readonly liveProgress?: boolean;
    readonly credentials?: MemoryCredentialStore;
    readonly server?: FixtureServer;
    readonly state?: MemoryStateStore;
    readonly studentInterface?: FixtureInterface;
    readonly workspace?: FixtureWorkspace;
  } = {},
) {
  const ids = new FixtureIds();
  const state = options.state ?? new MemoryStateStore();
  const credentials = options.credentials ?? new MemoryCredentialStore();
  const server = options.server ?? new FixtureServer();
  const studentInterface = options.studentInterface ?? new FixtureInterface();
  const agent = options.agent ?? new FixtureAgent();
  const workspace = options.workspace ?? new FixtureWorkspace();
  const localSession = new LocalSession(state, ids, FIXTURE_CLOCK);
  return {
    agent,
    controller: new StudentSessionController({
      ...(options.operations === undefined ? {} : { operations: options.operations }),
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      ...(options.liveProgress === undefined ? {} : { liveProgress: options.liveProgress }),
      agent,
      clientVersion: "1.0.0",
      clock: FIXTURE_CLOCK,
      credentials,
      ids,
      localSession,
      server,
      studentInterface,
      workspace,
    }),
    credentials,
    localSession,
    server,
    state,
    studentInterface,
    workspace,
  };
}
