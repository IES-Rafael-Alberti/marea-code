import type { OperationExecutor } from "./operation-contracts.js";
import type { ProjectEvidence } from "./project-evidence.js";
import {
  CURRENT_PROTOCOL_VERSION,
  MessageIdSchema,
  STARTUP_MESSAGE_ID,
  type RunId,
  type RunToken,
  type SessionToken,
  type StudentRunSnapshot,
} from "@marea/protocol";

import type {
  AgentRuntime,
  AuthenticationInput,
  ClassPreferenceStore,
  Clock,
  CredentialStore,
  ExternalAuthorization,
  GuardedWorkspaceWriter,
  IdSource,
  PendingStudentTurn,
  StoredCloseReason,
  StoredRun,
  StudentInterface,
  StudentServer,
} from "./contracts.js";
import { NoActiveRunError } from "./contracts.js";
import { LocalSession } from "./local-session.js";
import { SerialOperationQueue } from "./serial-operation-queue.js";
import { negotiateSessionCapabilities } from "./session-capabilities.js";
import { bootstrapClass, discoverProviders, exchangeExternal } from "./session-sign-in.js";
import {
  SessionTurnExecutor,
  type ActiveRun,
  type StableTurnIdentity,
} from "./session-turn-executor.js";

const RENEWAL_LEAD_TIME_MS = 60 * 1_000;
export interface SessionControllerOptions {
  readonly liveProgress?: boolean;
  readonly evidence?: ProjectEvidence;
  readonly operations?: OperationExecutor;
  readonly agent: AgentRuntime;
  readonly classPreference?: ClassPreferenceStore;
  readonly clientVersion: string;
  readonly clock: Clock;
  readonly credentials: CredentialStore;
  readonly externalAuthorization?: ExternalAuthorization | undefined;
  readonly ids: IdSource;
  readonly localSession: LocalSession;
  readonly server: StudentServer;
  readonly studentInterface: StudentInterface;
  readonly workspace: GuardedWorkspaceWriter;
}

export interface ActiveStudentSession {
  readonly classroomDisplayName: string;
  readonly projectDisplayName: string;
  readonly runId: RunId;
  readonly snapshot: StudentRunSnapshot;
}

export class StudentSessionController {
  private readonly lifecycle = new SerialOperationQueue();
  private readonly deliveries = new SerialOperationQueue();
  private presenceTimer: ReturnType<typeof setInterval> | undefined;
  private presenceBusy = false;
  private readonly closeAbort = new AbortController();
  private closeAttempt: Promise<void> | null = null;
  private closeRequested: StoredCloseReason | null = null;
  private leaseCheck: Promise<StoredRun> | null = null;
  private sessionToken: SessionToken | null = null;
  /** Set from the negotiated capabilities before any interactive sign-in. */
  private externalSignIn!: boolean;
  private readonly turns: SessionTurnExecutor;

  constructor(private readonly options: SessionControllerOptions) {
    this.turns = new SessionTurnExecutor({
      agent: options.agent,
      liveProgress: options.liveProgress,
      operations: options.operations,
      evidence: options.evidence,
      flushOutbox: () => this.flushOutbox(),
      ids: options.ids,
      localSession: options.localSession,
      requireActiveRun: () => this.requireActiveRun(),
      studentInterface: options.studentInterface,
      workspace: options.workspace,
    });
  }

  start(projectDisplayName: string): Promise<ActiveStudentSession> {
    if (this.closeRequested !== null) return Promise.reject(this.closingError());
    return this.lifecycle.run(async () => {
      if (this.closeRequested !== null) throw this.closingError();
      const active = await this.startInternal(projectDisplayName);
      await this.options.evidence?.start();
      await this.flushOutbox();
      if (
        !this.closeAbort.signal.aborted &&
        this.options.server.heartbeat !== undefined &&
        this.presenceTimer === undefined
      ) {
        const send = async () => {
          if (this.presenceBusy || this.closeRequested !== null) return;
          this.presenceBusy = true;
          try {
            const token = await this.modelRunToken();
            if (!this.closeAbort.signal.aborted) await this.options.server.heartbeat?.(token);
          } catch {
            /* Presence never interrupts a student session. */
          } finally {
            this.presenceBusy = false;
          }
        };
        this.presenceTimer = setInterval(() => {
          void send();
        }, 30000);
        this.presenceTimer.unref();
        void send();
      }
      return active;
    });
  }

  sendMessage(
    messageId: string,
    text: string,
    signal: AbortSignal,
    attemptId = this.options.ids.attempt(),
  ): Promise<void> {
    const stableMessageId = MessageIdSchema.parse(messageId);
    const identity: StableTurnIdentity = Object.freeze({ attemptId, messageId: stableMessageId });
    if (this.closeRequested !== null) return Promise.reject(this.closingError());
    return this.lifecycle.run(async () => {
      if (this.closeRequested !== null) throw this.closingError();
      await this.turns.sendMessage(
        identity,
        text,
        AbortSignal.any([signal, this.closeAbort.signal]),
      );
    });
  }

  sendStartup(signal: AbortSignal, attemptId = this.options.ids.attempt()): Promise<void> {
    if (this.closeRequested !== null) return Promise.reject(this.closingError());
    return this.lifecycle.run(() => {
      if (this.closeRequested !== null) throw this.closingError();
      return this.turns.sendStartup(
        { attemptId, messageId: STARTUP_MESSAGE_ID },
        AbortSignal.any([signal, this.closeAbort.signal]),
      );
    });
  }

  close(reason: StoredCloseReason = "student-exit"): Promise<void> {
    clearInterval(this.presenceTimer);
    this.presenceTimer = undefined;
    this.closeRequested ??= reason;
    this.closeAbort.abort();
    if (this.closeAttempt !== null) return this.closeAttempt;
    const selectedReason = this.closeRequested;
    const attempt = this.lifecycle.run(() => this.closeInternal(selectedReason));
    this.closeAttempt = attempt.finally(() => {
      this.closeAttempt = null;
    });
    return this.closeAttempt;
  }

  modelRunToken(): Promise<RunToken> {
    if (this.closeRequested !== null) return Promise.reject(this.closingError());
    return this.ensureLease().then((run) => {
      if (run.phase !== "active" || run.runId === null || run.runToken === null) {
        throw new NoActiveRunError("No active run token is available for model inference.");
      }
      return run.runToken;
    });
  }

  pendingTurn(): Promise<PendingStudentTurn | null> {
    if (this.closeRequested !== null) return Promise.reject(this.closingError());
    return this.options.localSession.pendingTurn();
  }

  private async startInternal(projectDisplayName: string): Promise<ActiveStudentSession> {
    const capabilities = await negotiateSessionCapabilities({
      clientVersion: this.options.clientVersion,
      ids: this.options.ids,
      server: this.options.server,
    });
    this.externalSignIn = capabilities.includes("marea.auth.external");
    const authenticated = await this.authenticate();
    this.sessionToken = authenticated.token;
    let bootstrap = authenticated.bootstrap;
    let pending = (await this.options.localSession.load()).run;
    if (pending?.phase === "closing") {
      await this.settlePendingClose(pending);
      bootstrap = await this.bootstrap(authenticated.token);
      pending = (await this.options.localSession.load()).run;
    }
    const matchingLocal =
      pending !== null &&
      pending.projectDisplayName === projectDisplayName &&
      (pending.phase === "active" || pending.phase === "opening")
        ? pending
        : null;
    const resumeRunId =
      matchingLocal?.runId ??
      (bootstrap.activeRun?.projectDisplayName === projectDisplayName
        ? bootstrap.activeRun.runId
        : null);
    if (
      matchingLocal?.phase === "opening" &&
      matchingLocal.openIntent.kind === "resume" &&
      matchingLocal.runId === null
    ) {
      throw new Error("The pending run resume has no server identifier.");
    }
    const desiredIntent =
      resumeRunId === null ? ({ kind: "new" } as const) : ({ kind: "resume" } as const);
    const local = await this.options.localSession.ensureOpening(
      projectDisplayName,
      desiredIntent,
      resumeRunId,
    );
    const opened = await this.options.server.openRun(authenticated.token, this.openRequest(local));
    await this.options.localSession.activate(opened);
    await this.flushOutbox();
    return {
      classroomDisplayName: bootstrap.classroom.displayName,
      projectDisplayName,
      runId: opened.lease.runId,
      snapshot: opened.snapshot,
    };
  }

  private async authenticate(): Promise<{
    readonly bootstrap: Awaited<ReturnType<StudentSessionController["bootstrap"]>>;
    readonly token: SessionToken;
  }> {
    const storedToken = await this.options.credentials.load();
    if (storedToken !== null) {
      const result = await bootstrapClass(this.options, storedToken);
      if (result.authenticated) return { bootstrap: result.value, token: storedToken };
      await this.options.credentials.clear();
      return this.authenticateInteractively("rejected");
    }
    return this.authenticateInteractively("missing");
  }

  private async authenticateInteractively(reason: "missing" | "rejected"): Promise<{
    readonly bootstrap: Awaited<ReturnType<StudentSessionController["bootstrap"]>>;
    readonly token: SessionToken;
  }> {
    const input = await this.options.studentInterface.authenticate(reason, {
      providers: await discoverProviders(this.options, this.externalSignIn),
    });
    const token = await this.exchangeAuthentication(input);
    await this.options.credentials.save(token);
    return { bootstrap: await this.bootstrap(token), token };
  }

  private async exchangeAuthentication(input: AuthenticationInput): Promise<SessionToken> {
    if (input.kind === "external") return exchangeExternal(this.options, input.providerId);
    if (input.kind === "enroll") {
      const response = await this.options.server.enroll({
        kind: "student-invitation-enrollment",
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: this.options.ids.request(),
        invitationCode: input.invitationCode,
        displayName: input.displayName,
        credentials: { login: input.login, password: input.password },
      });
      return response.session.token;
    }
    const response = await this.options.server.login({
      kind: "credential-login",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: this.options.ids.request(),
      credentials: { login: input.login, password: input.password },
    });
    if (response.principal.role !== "student") {
      throw new Error("Only a student account can start the Marea student application.");
    }
    return response.session.token;
  }

  private async bootstrap(token: SessionToken) {
    const response = await bootstrapClass(this.options, token);
    if (!response.authenticated) throw new Error("The new student session was rejected.");
    return response.value;
  }

  private async requireActiveRun(): Promise<ActiveRun> {
    const run = await this.ensureLease();
    if (
      run.phase !== "active" ||
      run.runId === null ||
      run.runToken === null ||
      run.snapshot === null
    ) {
      throw new NoActiveRunError("No active student run is available.");
    }
    return { runId: run.runId, runToken: run.runToken, snapshot: run.snapshot };
  }

  private ensureLease(): Promise<StoredRun> {
    if (this.leaseCheck !== null) return this.leaseCheck;
    const pending = this.ensureLeaseInternal();
    this.leaseCheck = pending.finally(() => {
      this.leaseCheck = null;
    });
    return this.leaseCheck;
  }

  private async ensureLeaseInternal(): Promise<StoredRun> {
    const run = (await this.options.localSession.load()).run;
    if (run === null) throw new NoActiveRunError("No active student run is available.");
    if (run.phase !== "active" && run.phase !== "closing") return run;
    if (run.runId === null || run.runToken === null) return run;
    const nowText = this.options.clock.now();
    const expiresAt = Date.parse(run.leaseExpiresAt ?? nowText);
    const now = Date.parse(nowText);
    if (Number.isFinite(expiresAt) && expiresAt - now > RENEWAL_LEAD_TIME_MS) return run;
    const sessionToken = await this.authenticationForRenewal();
    const current = (await this.options.localSession.load()).run;
    if (
      current?.runId !== run.runId ||
      (current.phase !== "active" && current.phase !== "closing")
    ) {
      throw new Error("The run changed while its lease was being renewed.");
    }
    const response = await this.options.server.renewLease(sessionToken, {
      kind: "run-lease-renewal",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: this.options.ids.request(),
      runId: run.runId,
    });
    return this.options.localSession.renewLease(response);
  }

  private async authenticationForRenewal(): Promise<SessionToken> {
    const candidate = this.sessionToken ?? (await this.options.credentials.load());
    if (candidate === null) {
      return this.refreshAuthenticationForRenewal("missing");
    } else {
      const response = await bootstrapClass(this.options, candidate);
      if (response.authenticated) {
        this.sessionToken = candidate;
        return candidate;
      }
      await this.options.credentials.clear();
      return this.refreshAuthenticationForRenewal("rejected");
    }
  }

  private async refreshAuthenticationForRenewal(
    reason: "missing" | "rejected",
  ): Promise<SessionToken> {
    const refreshed = await this.authenticateInteractively(reason);
    this.sessionToken = refreshed.token;
    return refreshed.token;
  }

  private flushOutbox(): Promise<void> {
    return this.deliveries.run(() => this.deliverOutbox());
  }

  private async deliverOutbox(): Promise<void> {
    for (;;) {
      const batch = await this.options.localSession.prepareDelivery(128);
      const [firstEvent] = batch;
      if (firstEvent === undefined) return;
      const run = await this.ensureLease();
      if (run.runToken === null) throw new Error("The active run token is unavailable.");
      const response = await this.options.server.appendRunEvents(run.runToken, {
        kind: "run-events-append",
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: this.options.ids.request(),
        events: batch,
      });
      const firstSequence = firstEvent.sequence;
      if (response.highestDurableSequence < firstSequence) {
        throw new Error("The teacher server did not acknowledge the pending event delivery.");
      }
      await this.options.localSession.acknowledge(response.highestDurableSequence);
    }
  }

  private async closeInternal(reason: StoredCloseReason): Promise<void> {
    const current = (await this.options.localSession.load()).run;
    if (current === null || current.phase === "closed") return;
    if (current.phase === "active") await this.options.evidence?.capture("student");
    let closing = await this.options.localSession.beginClose(reason);
    if (closing.runId === null) {
      closing = await this.recoverOpeningForClose(closing);
    }
    await this.settleClose(closing);
  }

  private async settlePendingClose(run: StoredRun): Promise<void> {
    const recovered = run.runId === null ? await this.recoverOpeningForClose(run) : run;
    await this.settleClose(recovered);
  }

  private async recoverOpeningForClose(run: StoredRun): Promise<StoredRun> {
    if (run.closeReason === null) throw new Error("The pending run close has no reason.");
    const token = this.sessionToken ?? (await this.authenticationForRenewal());
    const opened = await this.options.server.openRun(token, this.openRequest(run));
    await this.options.localSession.activate(opened);
    return this.options.localSession.beginClose(run.closeReason);
  }

  private async settleClose(run: StoredRun): Promise<void> {
    const runId = this.requireRunId(run);
    if (run.closeReason === null) throw new Error("The pending run close has no reason.");
    if (run.closeRequestId === null) throw new Error("The pending run close has no request ID.");
    await this.flushOutbox();
    const request = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: run.closeRequestId,
      reason: run.closeReason,
    } as const;
    const response =
      this.sessionToken !== null
        ? await this.options.server.closeRunAuthenticated(this.sessionToken, { ...request, runId })
        : run.runToken === null
          ? (() => {
              throw new Error("The pending run close has no run token.");
            })()
          : await this.options.server.closeRun(run.runToken, request);
    await this.options.localSession.finishClose(response);
  }

  private openRequest(run: StoredRun) {
    return {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      clientVersion: this.options.clientVersion,
      requestId: this.options.ids.request(),
      idempotencyKey: run.idempotencyKey,
      clientSessionId: run.clientSessionId,
      project: { displayName: run.projectDisplayName },
      intent: run.openIntent,
      ...(run.runId === null ? {} : { runId: run.runId }),
    } as const;
  }

  private closingError(): Error {
    return new Error("The student session is closing and cannot accept new turns.");
  }

  private requireRunId(run: StoredRun): RunId {
    if (run.runId === null) throw new Error("The local student run has no server identifier.");
    return run.runId;
  }
}
