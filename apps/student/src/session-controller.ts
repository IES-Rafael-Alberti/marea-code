/* eslint-disable max-lines -- Lease, close, and reopen recovery are one serial lifecycle state machine. */
import type { OperationExecutor } from "./operation-contracts.js";
import { TURN_DIAGNOSTICS_CAPABILITY } from "@marea/protocol";
import type { TurnDiagnosticsOptions } from "./turn-diagnostic-report.js";
import type { ProjectEvidence } from "./project-evidence.js";
import {
  CURRENT_PROTOCOL_VERSION,
  MessageIdSchema,
  STARTUP_MESSAGE_ID,
  type CloseRunResponse,
  type AppendRunEventsResponse,
  type CanonicalRunEvent,
  type OpenRunResponse,
  type RunId,
  type RunToken,
  type RenewRunLeaseResponse,
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
import { alreadyClosedResponse } from "./closed-run-response.js";
import { ConnectionDiagnostics } from "./connection-diagnostics.boundary.js";
import { StudentHttpError } from "./http-error.js";
import { LocalSession, type ReopenStoredRun } from "./local-session.js";
import { SerialOperationQueue } from "./serial-operation-queue.js";
import { SessionPresence } from "./session-presence.js";
import { SharedLeaseCheck, signInRequired } from "./lease-check.js";
import { negotiateSessionCapabilities } from "./session-capabilities.js";
import { bootstrapClass, discoverProviders, exchangeExternal } from "./session-sign-in.js";
import {
  SessionTurnExecutor,
  type ActiveRun,
  type StableTurnIdentity,
} from "./session-turn-executor.js";

const RENEWAL_LEAD_TIME_MS = 60 * 1_000;

export type StudentStartupStage =
  "capabilities" | "authentication" | "bootstrap" | "run-open" | "outbox";

/** The server refused the run itself, not the class configuration it needs. */
function isRunUnavailable(error: StudentHttpError): boolean {
  return error.code === "run.unavailable" && !error.classConfigurationRequired;
}

/** The server will refuse this event every time; retrying it can only block the ones after it. */
function isPermanentRejection(error: StudentHttpError): boolean {
  return error.code === "request.invalid" && !error.retryable;
}

function isRejectedPendingClose(error: StudentHttpError): boolean {
  return isRunUnavailable(error) || (error.status === 401 && error.code === "auth.invalid");
}

export interface SessionControllerOptions {
  readonly liveProgress?: boolean;
  /** Where failed attempts are recorded; the controller says whether the server stores them. */
  readonly diagnostics?: Omit<TurnDiagnosticsOptions, "reportToServer"> & {
    readonly onServerSupport?: (supported: boolean) => void;
  };
  /** Every capability the teacher's server announced, once per start. */
  readonly onServerCapabilities?: (capabilities: readonly string[]) => void;
  /** Confirms that the student accepts a server whose software version differs from this client. */
  readonly versionGate?:
    ((serverVersion: string, clientVersion: string) => Promise<void>) | undefined;
  readonly evidence?: ProjectEvidence;
  readonly operations?: OperationExecutor;
  readonly onStartupStage?: ((stage: StudentStartupStage) => void) | undefined;
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
  private presence: SessionPresence | undefined;
  private readonly closeAbort = new AbortController();
  private closeAttempt: Promise<void> | null = null;
  private closeRequested: StoredCloseReason | null = null;
  private readonly leaseChecks = new SharedLeaseCheck((interactive) =>
    this.ensureLeaseInternal(interactive),
  );
  private startupComplete = false;
  private sessionToken: SessionToken | null = null;
  /** Set from the negotiated capabilities before any interactive sign-in. */
  private externalSignIn!: boolean;
  /** Set from the negotiated capabilities before any turn can fail. */
  private turnDiagnostics!: boolean;
  private readonly turns: SessionTurnExecutor;
  private readonly connection: ConnectionDiagnostics;

  constructor(private readonly options: SessionControllerOptions) {
    const diagnostics = options.diagnostics;
    this.connection = new ConnectionDiagnostics({
      clock: options.clock,
      diagnostics,
      ids: options.ids,
      localSession: options.localSession,
      reportToServer: () => this.turnDiagnostics,
    });
    this.turns = new SessionTurnExecutor({
      ...(diagnostics === undefined
        ? {}
        : { diagnostics: { ...diagnostics, reportToServer: () => this.turnDiagnostics } }),
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
      const heartbeat = this.options.server.heartbeat?.bind(this.options.server);
      if (
        !this.closeAbort.signal.aborted &&
        heartbeat !== undefined &&
        this.presence === undefined
      ) {
        this.presence = new SessionPresence({
          aborted: () => this.closeAbort.signal.aborted,
          closing: () => this.closeRequested !== null,
          connection: this.connection,
          heartbeat,
          token: () => this.modelRunToken(false),
        });
        this.presence.start();
      }
      this.startupComplete = true;
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
    this.presence?.stop();
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

  /** A background caller passes `interactive: false`: it is then never asked to sign in. */
  modelRunToken(interactive = true): Promise<RunToken> {
    if (this.closeRequested !== null) return Promise.reject(this.closingError());
    return this.ensureLease(interactive).then((run) => {
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

  /** Stage labels describe startup only; later re-authentication keeps the reported stage. */
  private reportStartupStage(stage: StudentStartupStage): void {
    if (!this.startupComplete) this.options.onStartupStage?.(stage);
  }

  private async startInternal(projectDisplayName: string): Promise<ActiveStudentSession> {
    this.startupComplete = false;
    this.reportStartupStage("capabilities");
    const capabilities = await negotiateSessionCapabilities({
      clientVersion: this.options.clientVersion,
      ids: this.options.ids,
      server: this.options.server,
      versionGate: this.options.versionGate,
    });
    this.externalSignIn = capabilities.includes("marea.auth.external");
    this.turnDiagnostics = capabilities.includes(TURN_DIAGNOSTICS_CAPABILITY);
    this.options.diagnostics?.onServerSupport?.(this.turnDiagnostics);
    this.options.onServerCapabilities?.(capabilities);
    this.reportStartupStage("authentication");
    const authenticated = await this.authenticate();
    this.sessionToken = authenticated.token;
    let bootstrap = authenticated.bootstrap;
    let pending: ReopenStoredRun | null = (await this.options.localSession.load()).run;
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
    const serverRunId =
      bootstrap.activeRun?.projectDisplayName === projectDisplayName
        ? bootstrap.activeRun.runId
        : null;
    const resumeRunId = matchingLocal?.runId ?? serverRunId;
    if (
      matchingLocal?.phase === "opening" &&
      matchingLocal.openIntent.kind === "resume" &&
      matchingLocal.runId === null
    ) {
      throw new Error("The pending run resume has no server identifier.");
    }
    const local = await this.options.localSession.ensureOpening(
      projectDisplayName,
      resumeRunId === null ? { kind: "new" } : { kind: "resume" },
      resumeRunId,
    );
    this.reportStartupStage("run-open");
    const opened = await this.openOrSetAside(authenticated.token, local, {
      projectDisplayName,
      serverRunId,
    });
    await this.options.localSession.activate(opened);
    await this.showStoredUsage();
    await this.flushOutbox();
    return {
      classroomDisplayName: bootstrap.classroom.displayName,
      projectDisplayName,
      runId: opened.lease.runId,
      snapshot: opened.snapshot,
    };
  }

  /**
   * Local state is keyed by server and folder, not by student, and the server may close runs
   * (for example, the teacher). When the server refuses the run being resumed (another account,
   * another class, or already closed), set it aside once and continue with this student's own
   * active run or a fresh one instead of retrying the refused resume on every start. Its
   * undeliverable events stay set aside locally and are never sent. A class configuration
   * refusal keeps the stored run, because the run itself is still valid.
   */
  /** A resumed session shows the usage it had before the restart. */
  private async showStoredUsage(): Promise<void> {
    // Stryker disable next-line OptionalChaining: the run has just been activated.
    const usage = (await this.options.localSession.load()).run?.usage;
    if (usage !== undefined) this.options.studentInterface.showUsage?.(usage);
  }

  private async openOrSetAside(
    token: SessionToken,
    local: StoredRun,
    context: {
      readonly projectDisplayName: string;
      readonly serverRunId: RunId | null;
    },
  ): Promise<OpenRunResponse> {
    try {
      return await this.options.server.openRun(token, this.openRequest(local));
    } catch (error) {
      if (
        local.openIntent.kind !== "resume" ||
        !(error instanceof StudentHttpError) ||
        !isRunUnavailable(error)
      )
        throw error;
      const fallbackRunId = context.serverRunId === local.runId ? null : context.serverRunId;
      const fresh = await this.options.localSession.ensureOpening(
        context.projectDisplayName,
        fallbackRunId === null ? { kind: "new" } : { kind: "resume" },
        fallbackRunId,
        true,
      );
      return this.options.server.openRun(token, this.openRequest(fresh));
    }
  }

  private async authenticate(): Promise<{
    readonly bootstrap: Awaited<ReturnType<StudentSessionController["bootstrap"]>>;
    readonly token: SessionToken;
  }> {
    const storedToken = await this.options.credentials.load();
    if (storedToken !== null) {
      this.reportStartupStage("bootstrap");
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
    this.reportStartupStage("authentication");
    const authenticate = async () => {
      const input = await this.options.studentInterface.authenticate(reason, {
        providers: await discoverProviders(this.options, this.externalSignIn),
      });
      const token = await this.exchangeAuthentication(input);
      await this.options.credentials.save(token);
      return { bootstrap: await this.bootstrap(token), token };
    };
    return this.options.studentInterface.withAuthentication?.(authenticate) ?? authenticate();
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
    this.reportStartupStage("bootstrap");
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

  private ensureLease(interactive = true): Promise<StoredRun> {
    return this.leaseChecks.run(interactive);
  }

  private async ensureLeaseInternal(interactive: boolean): Promise<StoredRun> {
    const run = (await this.options.localSession.load()).run;
    if (run === null) throw new NoActiveRunError("No active student run is available.");
    if (run.phase !== "active" && run.phase !== "closing") return run;
    if (run.runId === null || run.runToken === null) return run;
    const nowText = this.options.clock.now();
    const expiresAt = Date.parse(run.leaseExpiresAt ?? nowText);
    const now = Date.parse(nowText);
    if (Number.isFinite(expiresAt) && expiresAt - now > RENEWAL_LEAD_TIME_MS) return run;
    const sessionToken = await this.authenticationForRenewal(interactive);
    const current = (await this.options.localSession.load()).run;
    if (
      current?.runId !== run.runId ||
      (current.phase !== "active" && current.phase !== "closing")
    ) {
      throw new Error("The run changed while its lease was being renewed.");
    }
    let response: RenewRunLeaseResponse;
    try {
      response = await this.options.server.renewLease(sessionToken, {
        kind: "run-lease-renewal",
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: this.options.ids.request(),
        runId: run.runId,
      });
    } catch (error) {
      if (!(error instanceof StudentHttpError) || !isRunUnavailable(error)) throw error;
      await this.reopenRevokedLease(run, sessionToken);
      // The retry is outside recovery handling: a second rejection propagates.
      response = await this.options.server.renewLease(sessionToken, {
        kind: "run-lease-renewal",
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: this.options.ids.request(),
        runId: this.requireRunId(run),
      });
    }
    return this.options.localSession.renewLease(response);
  }

  private async reopenRevokedLease(
    run: StoredRun,
    authenticatedToken?: SessionToken,
  ): Promise<StoredRun> {
    const current = (await this.options.localSession.load()).run;
    if (
      current?.runId !== run.runId ||
      (current.phase !== "active" && current.phase !== "closing")
    ) {
      throw new Error("The run changed while its revoked lease was being recovered.");
    }
    const closing = current.phase === "closing";
    if (closing && current.closeReason === null) {
      throw new Error("The pending run close has no reason.");
    }
    const closeReason = closing ? current.closeReason : null;
    const sessionToken = authenticatedToken ?? (await this.authenticationForRenewal());
    const opening = await this.options.localSession.reopenLease(this.requireRunId(current));
    let activated: StoredRun;
    try {
      const opened = await this.options.server.openRun(sessionToken, this.openRequest(opening));
      activated = await this.options.localSession.activate(opened);
    } catch (error) {
      // A failed reopen must not strand the run in `opening`: the next call tries again.
      await this.options.localSession.restoreAfterFailedReopen(
        this.requireRunId(current),
        closing ? "closing" : "active",
      );
      throw error;
    }
    return closeReason === null ? activated : this.options.localSession.beginClose(closeReason);
  }

  private async authenticationForRenewal(interactive = true): Promise<SessionToken> {
    const candidate = this.sessionToken ?? (await this.options.credentials.load());
    if (candidate === null) {
      if (!interactive) throw signInRequired();
      return this.refreshAuthenticationForRenewal("missing");
    } else {
      const response = await bootstrapClass(this.options, candidate);
      if (response.authenticated) {
        this.sessionToken = candidate;
        return candidate;
      }
      if (!interactive) throw signInRequired();
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
    this.reportStartupStage("outbox");
    return this.deliveries.run(() => this.deliverOutbox());
  }

  private async deliverOutbox(): Promise<void> {
    for (;;) {
      const batch = await this.options.localSession.prepareDelivery(128);
      const [firstEvent] = batch;
      if (firstEvent === undefined) return;
      let response: AppendRunEventsResponse;
      try {
        response = await this.appendBatch(batch);
      } catch (error) {
        if (!(error instanceof StudentHttpError) || !isPermanentRejection(error)) throw error;
        await this.isolateRejection(batch.length, error);
        continue;
      }
      if (response.highestDurableSequence < firstEvent.sequence) {
        throw new Error("The teacher server did not acknowledge the pending event delivery.");
      }
      await this.options.localSession.acknowledge(response.highestDurableSequence);
    }
  }

  private async appendBatch(batch: readonly CanonicalRunEvent[]): Promise<AppendRunEventsResponse> {
    const run = await this.ensureLease();
    if (run.runToken === null) throw new Error("The active run token is unavailable.");
    const request = {
      kind: "run-events-append",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: this.options.ids.request(),
      events: batch,
    } as const;
    try {
      return await this.options.server.appendRunEvents(run.runToken, request);
    } catch (error) {
      if (!(error instanceof StudentHttpError) || !isRunUnavailable(error)) throw error;
      const reopened = await this.reopenRevokedLease(run);
      if (reopened.runToken === null) {
        throw new Error("The active run token is unavailable.", { cause: error });
      }
      // Retry the same idempotent delivery once with the resumed run lease.
      return this.options.server.appendRunEvents(reopened.runToken, request);
    }
  }

  /**
   * The server refuses a whole delivery when any event in it is refused, so a refused batch is
   * retried one event at a time; an event refused on its own is set aside and delivery goes on.
   */
  private async isolateRejection(batchSize: number, error: StudentHttpError): Promise<void> {
    if (batchSize > 1) {
      await this.options.localSession.narrowDelivery();
      return;
    }
    const event = await this.options.localSession.setAsideFirstPending();
    const log = this.options.diagnostics?.log;
    // Stryker disable next-line ConditionalExpression: without it the append below throws and the catch swallows it.
    if (log === undefined) return;
    try {
      await log.append({
        occurredAt: this.options.clock.now(),
        kind: "event-set-aside",
        status: error.status,
        code: error.code,
        event,
      });
    } catch {
      // The local copy is best effort; it never blocks the events that follow.
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
    await this.settleClose(recovered, true);
  }

  private async recoverOpeningForClose(run: StoredRun): Promise<StoredRun> {
    if (run.closeReason === null) throw new Error("The pending run close has no reason.");
    const token = this.sessionToken ?? (await this.authenticationForRenewal());
    this.reportStartupStage("run-open");
    const opened = await this.options.server.openRun(token, this.openRequest(run));
    await this.options.localSession.activate(opened);
    return this.options.localSession.beginClose(run.closeReason);
  }

  /**
   * Closing must not open an interactive sign-in while the student is leaving: an expired
   * session falls back to the still-valid run lease, and only a run without one re-authenticates.
   */
  private async closeSessionToken(run: StoredRun): Promise<SessionToken | null> {
    if (this.sessionToken === null) return null;
    const checked = await bootstrapClass(this.options, this.sessionToken);
    if (checked.authenticated) return this.sessionToken;
    const leaseExpiresAt = Date.parse(String(run.leaseExpiresAt));
    const leaseValid =
      Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.parse(this.options.clock.now());
    if (run.runToken !== null && leaseValid) return null;
    return this.authenticationForRenewal();
  }

  private async settleClose(run: StoredRun, rejectWithoutFailing = false): Promise<void> {
    const runId = this.requireRunId(run);
    if (run.closeReason === null) throw new Error("The pending run close has no reason.");
    if (run.closeRequestId === null) throw new Error("The pending run close has no request ID.");
    const closed = alreadyClosedResponse(run.closeRequestId, runId);
    try {
      await this.flushOutbox();
    } catch (error) {
      if (!(error instanceof StudentHttpError) || !isRunUnavailable(error)) throw error;
      // The server no longer accepts this run (a teacher ended it, or it expired), so nothing
      // more can be delivered and leaving it is already complete. Its undeliverable events
      // are discarded with the run, as after any other refused close.
      await this.options.localSession.finishClose(closed);
      return;
    }
    const request = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: run.closeRequestId,
      reason: run.closeReason,
    } as const;
    const sessionToken = await this.closeSessionToken(run);
    let response: CloseRunResponse;
    try {
      response =
        sessionToken !== null
          ? await this.options.server.closeRunAuthenticated(sessionToken, { ...request, runId })
          : run.runToken === null
            ? (() => {
                throw new Error("The pending run close has no run token.");
              })()
            : await this.options.server.closeRun(run.runToken, request);
    } catch (error) {
      if (
        !rejectWithoutFailing ||
        !(error instanceof StudentHttpError) ||
        !isRejectedPendingClose(error)
      ) {
        throw error;
      }
      response = closed;
    }
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
