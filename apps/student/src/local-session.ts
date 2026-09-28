import {
  STARTUP_MESSAGE_ID,
  type CanonicalRunEvent,
  type CloseRunResponse,
  type OpenRunResponse,
  type RenewRunLeaseResponse,
  type RunId,
} from "@marea/protocol";
import type {
  Clock,
  IdSource,
  PendingStudentTurn,
  StoredApproval,
  StoredCloseReason,
  StoredEffect,
  StoredOpenIntent,
  StoredPendingApproval,
  StoredRun,
  StoredTurn,
  StudentState,
  StudentStateStore,
  WorkspaceWrite,
} from "./contracts.js";
import { pendingStoredTurn } from "./pending-turn.js";
import { assertActivationCompatible } from "./local-session-recovery.js";
import { prepareStoredStartup, recordStartupProgress } from "./local-startup.js";
import { SerialOperationQueue } from "./serial-operation-queue.js";
import {
  beginStoredApproval,
  beginStoredTurn,
  finishStoredTurn,
  recordStoredApproval,
  recordStoredEffect,
  recordStoredEffectAndEvent,
  resolveStoredApproval,
  setStoredTurn,
  updateStoredTurnText,
  type EventFactory,
} from "./local-session-turns.js";

export type { EventFactory } from "./local-session-turns.js";

function freshOpening(
  projectDisplayName: string,
  openIntent: StoredOpenIntent,
  ids: IdSource,
  resumeRunId: RunId | null,
): StoredRun {
  return {
    approvals: [],
    clientSessionId: ids.clientSession(),
    closeReason: null,
    closeRequestId: null,
    effects: [],
    eventKeys: [],
    idempotencyKey: ids.idempotency(),
    leaseExpiresAt: null,
    leaseIssuedAt: null,
    nextSequence: 1,
    openIntent,
    outbox: [],
    pendingApprovals: [],
    pendingDelivery: null,
    phase: "opening",
    projectDisplayName,
    runId: resumeRunId,
    runToken: null,
    snapshot: null,
    snapshotId: null,
    turns: [],
  };
}

function resumeOpening(
  existing: StoredRun,
  openIntent: StoredOpenIntent,
  ids: IdSource,
): StoredRun {
  return {
    ...existing,
    clientSessionId: ids.clientSession(),
    closeReason: null,
    closeRequestId: null,
    idempotencyKey: ids.idempotency(),
    openIntent,
    phase: "opening",
  };
}

export class LocalSession {
  private readonly mutations = new SerialOperationQueue();

  constructor(
    private readonly store: StudentStateStore,
    private readonly ids: IdSource,
    private readonly clock: Clock,
  ) {}

  load(): Promise<StudentState> {
    return this.mutations.after(() => this.store.load());
  }

  pendingEvents(limit: number): Promise<readonly CanonicalRunEvent[]> {
    return this.load().then((state) => {
      if (state.run === null) return [];
      return (state.run.pendingDelivery?.events ?? state.run.outbox)
        .slice(0, limit)
        .map((event) => event.value);
    });
  }

  prepareDelivery(limit: number): Promise<readonly CanonicalRunEvent[]> {
    return this.mutateRun((run) => {
      if (run.pendingDelivery !== null && run.pendingDelivery !== undefined) return run;
      const events = run.outbox.slice(0, limit);
      return events.length === 0 ? run : { ...run, pendingDelivery: { events } };
    }).then((run) => run.pendingDelivery?.events.map((event) => event.value) ?? []);
  }

  ensureOpening(
    projectDisplayName: string,
    desiredIntent: StoredOpenIntent,
    resumeRunId: RunId | null = null,
  ): Promise<StoredRun> {
    return this.mutate((state) => {
      const existing = state.run;
      if (
        existing !== null &&
        existing.phase === "opening" &&
        existing.projectDisplayName === projectDisplayName &&
        (existing.openIntent.kind === "new" ||
          (desiredIntent.kind === "resume" && existing.runId === resumeRunId))
      ) {
        return { state, value: existing };
      }
      const run =
        desiredIntent.kind === "resume" &&
        existing !== null &&
        existing.phase === "active" &&
        existing.projectDisplayName === projectDisplayName &&
        (resumeRunId === null || existing.runId === resumeRunId)
          ? resumeOpening(existing, desiredIntent, this.ids)
          : freshOpening(projectDisplayName, desiredIntent, this.ids, resumeRunId);
      return { state: { ...state, run }, value: run };
    });
  }

  activate(response: OpenRunResponse): Promise<StoredRun> {
    return this.mutateRun((run) => {
      assertActivationCompatible(run, response);
      return prepareStoredStartup(
        {
          ...run,
          nextSequence: Math.max(run.nextSequence, response.highestDurableSequence + 1),
          phase: "active",
          leaseExpiresAt: response.lease.expiresAt,
          leaseIssuedAt: response.lease.issuedAt,
          runId: response.lease.runId,
          runToken: response.lease.token,
          snapshot: response.snapshot,
          snapshotId: response.snapshot.id,
        },
        response,
      );
    });
  }

  renewLease(response: RenewRunLeaseResponse): Promise<StoredRun> {
    return this.mutateRun((run) => {
      if (run.phase !== "active" && run.phase !== "closing") {
        throw new Error("A lease can only be renewed for a live local run.");
      }
      if (run.runId !== response.lease.runId) {
        throw new Error("The lease response addressed another run.");
      }
      return {
        ...run,
        leaseExpiresAt: response.lease.expiresAt,
        leaseIssuedAt: response.lease.issuedAt,
        runToken: response.lease.token,
      };
    });
  }

  appendEvent(key: string, factory: EventFactory): Promise<StoredRun> {
    return this.mutateRun((run) => {
      if (run.eventKeys.includes(key)) return run;
      const event = factory(run.nextSequence, this.clock.now());
      return {
        ...run,
        eventKeys: [...run.eventKeys, key],
        nextSequence: run.nextSequence + 1,
        outbox: [...run.outbox, { key, value: event }],
      };
    });
  }

  beginTurn(messageId: string, studentText: string, factory: EventFactory): Promise<StoredRun> {
    return this.mutateRun((run) =>
      beginStoredTurn(run, messageId, studentText, factory, this.clock),
    );
  }

  recordTurnFailure(
    messageId: string,
    lastFailure: import("./contracts.js").TurnFailureInfo,
  ): Promise<StoredRun> {
    return this.mutateRun((run) => ({
      ...run,
      turns: run.turns.map((turn) =>
        turn.messageId === messageId ? { ...turn, lastFailure } : turn,
      ),
    }));
  }

  clearTurnFailure(messageId: string): Promise<StoredRun> {
    return this.mutateRun((run) => ({
      ...run,
      turns: run.turns.map((turn) => {
        if (turn.messageId !== messageId) return turn;
        const cleared = { ...turn };
        delete cleared.lastFailure;
        return cleared;
      }),
    }));
  }

  pendingTurn(): Promise<PendingStudentTurn | null> {
    return this.load().then((state) => pendingStoredTurn(state.run));
  }

  updateTurnText(messageId: string, text: string): Promise<StoredRun> {
    return this.mutateRun((run) => updateStoredTurnText(run, messageId, text));
  }

  beginStartup(): Promise<StoredRun> {
    return this.mutateRun((run) => {
      if (
        run.phase !== "active" ||
        !run.turns.some(
          (turn) =>
            turn.messageId === STARTUP_MESSAGE_ID &&
            turn.kind === "startup" &&
            turn.state === "started",
        )
      ) {
        throw new Error("No pending tutor startup is available.");
      }
      return recordStartupProgress(run, "started", this.ids, this.clock);
    });
  }

  beginApproval(replacement: StoredPendingApproval, factory: EventFactory): Promise<StoredRun> {
    return this.mutateRun((run) => beginStoredApproval(run, replacement, factory, this.clock));
  }

  findPendingApproval(
    approvalId: StoredPendingApproval["approvalId"],
  ): Promise<StoredPendingApproval | null> {
    return this.load().then(
      (state) =>
        state.run?.pendingApprovals?.find((approval) => approval.approvalId === approvalId) ?? null,
    );
  }

  resolveApproval(replacement: StoredApproval, factory: EventFactory): Promise<StoredRun> {
    return this.mutateRun((run) => resolveStoredApproval(run, replacement, factory, this.clock));
  }

  recordEffectAndEvent(
    effect: StoredEffect,
    key: string,
    factory: EventFactory,
  ): Promise<StoredRun> {
    return this.mutateRun((run) =>
      recordStoredEffectAndEvent(run, effect, key, factory, this.clock),
    );
  }

  finishTurn(
    messageId: string,
    state: "completed" | "cancelled",
    text: string,
  ): Promise<StoredRun> {
    return this.mutateRun((run) => {
      const finished = finishStoredTurn(run, messageId, state, text, this.ids, this.clock);
      return run.turns.find((turn) => turn.messageId === messageId)?.kind === "startup"
        ? recordStartupProgress(finished, state, this.ids, this.clock)
        : finished;
    });
  }

  acknowledge(highestDurableSequence: number): Promise<StoredRun> {
    return this.mutateRun((run) => {
      // Delivered progress is observational; retaining its keys would exhaust
      // the bounded state during long sessions. Decisions keep their keys.
      const progress = new Set(
        run.outbox
          .filter(
            (event) =>
              event.value.eventType === "assistant-progress" &&
              event.value.sequence <= highestDurableSequence,
          )
          .map((event) => event.key),
      );
      return {
        ...run,
        eventKeys: run.eventKeys.filter((key) => !progress.has(key)),
        outbox: run.outbox.filter((event) => event.value.sequence > highestDurableSequence),
        pendingDelivery:
          run.pendingDelivery === null || run.pendingDelivery === undefined
            ? null
            : (() => {
                const events = run.pendingDelivery.events.filter(
                  (event) => event.value.sequence > highestDurableSequence,
                );
                return events.length === 0 ? null : { events };
              })(),
      };
    });
  }

  recordEffect(effectId: string, result: WorkspaceWrite): Promise<StoredEffect> {
    const replacement = { effectId, result };
    return this.mutateRun((run) => recordStoredEffect(run, replacement)).then(() => replacement);
  }

  recordApproval(replacement: StoredApproval): Promise<StoredApproval> {
    return this.mutateRun((run) => recordStoredApproval(run, replacement)).then(() => replacement);
  }

  findApproval(approvalId: StoredApproval["approvalId"]): Promise<StoredApproval | null> {
    return this.load().then(
      (state) =>
        state.run?.approvals.find((approval) => approval.approvalId === approvalId) ?? null,
    );
  }

  findEffect(effectId: string): Promise<StoredEffect | null> {
    return this.load().then(
      (state) => state.run?.effects.find((effect) => effect.effectId === effectId) ?? null,
    );
  }

  setTurn(replacement: StoredTurn): Promise<StoredRun> {
    return this.mutateRun((run) => setStoredTurn(run, replacement));
  }

  findTurn(messageId: string): Promise<StoredTurn | null> {
    return this.load().then(
      (state) => state.run?.turns.find((turn) => turn.messageId === messageId) ?? null,
    );
  }

  beginClose(reason: StoredCloseReason): Promise<StoredRun> {
    return this.mutateRun((run) => ({
      ...run,
      closeReason: run.closeReason ?? reason,
      closeRequestId: run.closeRequestId ?? this.ids.request(),
      phase: run.phase === "closed" ? "closed" : "closing",
    }));
  }

  finishClose(response: CloseRunResponse): Promise<StoredRun> {
    return this.mutateRun((run) => {
      if (run.runId !== response.runId) {
        throw new Error("The close response addressed another run.");
      }
      return {
        ...run,
        leaseExpiresAt: null,
        leaseIssuedAt: null,
        outbox: [],
        pendingDelivery: null,
        phase: "closed",
        runToken: null,
      };
    });
  }

  private mutateRun(transform: (run: StoredRun) => StoredRun): Promise<StoredRun> {
    return this.mutate((state) => {
      if (state.run === null) throw new Error("No local student run exists.");
      const run = transform(state.run);
      return { state: { ...state, run }, value: run };
    });
  }

  private mutate<T>(
    operation: (state: StudentState) => { readonly state: StudentState; readonly value: T },
  ): Promise<T> {
    return this.mutations.run(async () => {
      const current = await this.store.load();
      const result = operation(current);
      if (result.state !== current) await this.store.save(result.state);
      return result.value;
    });
  }
}
