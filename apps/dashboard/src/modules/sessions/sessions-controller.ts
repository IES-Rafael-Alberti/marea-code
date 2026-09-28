import { SessionRefresh } from "./session-refresh.js";
import { SessionDrafts } from "./session-drafts.js";
import type { SessionsClient } from "./sessions-client.boundary.js";
import type { CanonicalRunEvent, ClassSessionItem } from "@marea/protocol";
import { EvaluationRequestError } from "../evaluation/evaluation-client.boundary.js";
import type { EvaluationController } from "../evaluation/evaluation-controller.js";
import type { NoticeClient } from "./notice-client.boundary.js";
import type { NoticeController } from "./notice-controller.js";

export interface SessionsState {
  readonly classId: string | null;
  readonly runs: readonly ClassSessionItem[];
  readonly next: string | null;
  readonly runId: string | null;
  readonly selected: ClassSessionItem | null;
  readonly events: readonly CanonicalRunEvent[];
  readonly connection: "loading" | "current" | "stale";
  readonly updatedAt: number | null;
  readonly catchingUp: boolean;
  readonly moreBusy: boolean;
}
export const SESSION_POLL_MS = 2000;
/** Read-only polling has separate lifetime and selection cancellation; mutations live elsewhere. */
export class SessionsController {
  public state: SessionsState = {
    classId: null,
    runs: [],
    next: null,
    runId: null,
    selected: null,
    events: [],
    connection: "loading",
    updatedAt: null,
    catchingUp: false,
    moreBusy: false,
  };
  private readonly lifetime = new AbortController();
  private selection = new AbortController();
  private listing = new AbortController();
  private readonly refreshLoop = new SessionRefresh(async () => {
    await Promise.all([this.loadRuns(false), this.loadHistory(), this.notice?.refresh()]);
  }, SESSION_POLL_MS);
  private unsubscribe: (() => void) | undefined;
  private listFailed = false;
  private historyFailed: boolean | undefined;
  private listCursor: string | null = null;
  private readonly historyRequests = new Set<AbortSignal>();
  private through: number | undefined;
  private readonly drafts: SessionDrafts;
  constructor(
    private readonly client: SessionsClient,
    noticeClient: NoticeClient,
    private readonly changed: () => void,
  ) {
    this.drafts = new SessionDrafts(client, noticeClient, changed);
  }
  get hasUnsavedDrafts(): boolean {
    return this.drafts.hasUnsavedDrafts;
  }
  get review(): EvaluationController | undefined {
    return this.drafts.review(this.state.runId);
  }
  get notice(): NoticeController | undefined {
    return this.drafts.notice(this.state.runId);
  }
  start(): Promise<void> {
    this.unsubscribe ??= this.client.subscribe?.(() => {
      this.refreshLoop.invalidate();
    });
    return this.refresh();
  }
  async chooseClass(classId: string | null): Promise<void> {
    this.listing.abort();
    this.listing = new AbortController();
    this.listCursor = null;
    this.listFailed = false;
    this.selection.abort();
    this.selection = new AbortController();
    this.through = undefined;
    this.update({
      classId,
      runId: null,
      selected: null,
      events: [],
      runs: [],
      next: null,
      updatedAt: null,
      connection: "loading",
      moreBusy: false,
      catchingUp: false,
    });
    await this.loadRuns(false);
  }
  async select(runId: string | null): Promise<void> {
    this.selection.abort();
    this.selection = new AbortController();
    this.through = undefined;
    this.historyFailed = false;
    this.update({
      runId,
      selected: this.state.runs.find((run) => run.runId === runId) ?? null,
      events: [],
      updatedAt: null,
      connection: "loading",
      catchingUp: false,
    });
    if (runId === null) {
      this.update({ connection: this.listFailed ? "stale" : "current" });
      return;
    }
    this.drafts.select(runId);
    await this.loadHistory();
  }
  openEvaluation(): Promise<void> {
    return this.drafts.openReview(this.state.runId);
  }
  async newest(): Promise<void> {
    this.listCursor = null;
    await this.loadRuns(false);
  }
  async more(): Promise<void> {
    if (this.state.next !== null && !this.state.moreBusy) await this.loadRuns(true);
  }
  refresh(): Promise<void> {
    return this.refreshLoop.refresh();
  }
  dispose(): void {
    this.unsubscribe?.();
    this.lifetime.abort();
    this.selection.abort();
    this.listing.abort();
    this.refreshLoop.dispose();
    this.drafts.clear();
  }
  private async loadRuns(more: boolean): Promise<void> {
    if (!more && this.state.moreBusy) return;
    this.listing.abort();
    this.listing = new AbortController();
    const signal = this.listing.signal;
    const cursor = more ? this.state.next : this.listCursor;
    if (more) this.update({ moreBusy: true });
    try {
      const page = await this.client.classes(cursor, signal, this.state.classId ?? undefined);
      if (signal.aborted || this.lifetime.signal.aborted) return;
      this.listFailed = false;
      this.listCursor = cursor;
      const runs = page.runs;
      this.update({
        runs: [...new Map(runs.map((run) => [run.runId, run])).values()],
        next: page.nextBeforeRunId,
        selected: runs.find((run) => run.runId === this.state.runId) ?? this.state.selected,
        connection: this.listConnection(),
        ...(this.state.runId === null ? { updatedAt: Date.now() } : {}),
      });
    } catch (error) {
      if (!signal.aborted) {
        this.listFailed = true;
        if (error instanceof EvaluationRequestError && [401, 403].includes(error.status)) {
          this.clearAccess();
        }
        this.update({ connection: "stale" });
      }
    } finally {
      if (!signal.aborted) this.update({ moreBusy: false });
    }
  }
  private listConnection(): SessionsState["connection"] {
    if (this.state.runId === null) return "current";
    if (this.historyFailed) return "stale";
    return this.state.connection === "loading" ? "loading" : "current";
  }
  private clearAccess(): void {
    this.selection.abort();
    this.selection = new AbortController();
    this.drafts.clear();
    this.update({ runs: [], next: null, runId: null, selected: null, events: [], updatedAt: null });
  }
  private async loadHistory(): Promise<void> {
    const { runId, events } = this.state;
    if (runId === null) return;
    const signal = this.selection.signal;
    if (this.historyRequests.has(signal)) return;
    this.historyRequests.add(signal);
    try {
      const page = await this.client.history(
        runId,
        events.at(-1)?.sequence ?? 0,
        this.through,
        signal,
      );
      if (signal.aborted || this.lifetime.signal.aborted) return;
      this.historyFailed = false;
      this.through = page.nextSequence === null ? undefined : page.throughSequence;
      const merged = new Map(this.state.events.map((event) => [event.sequence, event]));
      for (const event of page.events) merged.set(event.sequence, event);
      this.update({
        events: [...merged.values()],
        catchingUp: page.nextSequence !== null,
        connection: this.listFailed ? "stale" : "current",
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (!signal.aborted) {
        this.historyFailed = true;
        if (error instanceof EvaluationRequestError && [401, 403, 404].includes(error.status)) {
          this.drafts.remove(runId);
          this.through = undefined;
          this.update({ runId: null, selected: null, events: [], connection: "stale" });
        } else this.update({ connection: "stale" });
      }
    } finally {
      this.historyRequests.delete(signal);
    }
  }
  private update(patch: Partial<SessionsState>): void {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    this.changed();
  }
}
