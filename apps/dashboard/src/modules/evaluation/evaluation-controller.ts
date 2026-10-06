import { browserRandomUUID } from "../../browser-random-uuid.js";
import {
  EvaluationDraftSchema,
  type EvaluationDraft,
  type EvaluationResponse,
  type RunHistoryResponse,
  type SessionHistoryResponse,
  type TeacherEvaluation,
} from "@marea/protocol";

import type { EvaluationClient } from "./evaluation-client.boundary.js";

export interface EvaluationState {
  readonly busy: boolean;
  readonly error: boolean;
  readonly sessions: SessionHistoryResponse | null;
  readonly runId: string | null;
  readonly history: RunHistoryResponse | null;
  readonly evaluation: TeacherEvaluation | null;
  readonly draft: EvaluationDraft | null;
  readonly uncertain: boolean;
  readonly pendingKind: "generate" | "approve" | null;
}

type PendingAction =
  | { readonly kind: "generate"; readonly key: string; readonly expectedId: string | null }
  | {
      readonly kind: "approve";
      readonly key: string;
      readonly evaluationId: string;
      readonly draft: EvaluationDraft;
    };

/** Owns one review at a time. Failed writes retain the exact body and key until readback. */
export class EvaluationController {
  public state: EvaluationState = {
    busy: false,
    error: false,
    sessions: null,
    runId: null,
    history: null,
    evaluation: null,
    draft: null,
    uncertain: false,
    pendingKind: null,
  };
  private pending: PendingAction | undefined;
  private readonly abort = new AbortController();

  public constructor(
    private readonly client: EvaluationClient,
    private readonly changed: (state: EvaluationState) => void,
    private readonly createKey: () => string = () => `evaluation:${browserRandomUUID()}`,
  ) {}

  public loadSessions(cursor: string | null = null): Promise<void> {
    return this.perform(async () => {
      const sessions = await this.client.sessions(cursor, this.abort.signal);
      this.update({ sessions });
    });
  }

  public select(runId: string): Promise<void> {
    return this.perform(async () => {
      this.pending = undefined;
      this.update({
        runId,
        history: null,
        evaluation: null,
        draft: null,
        uncertain: false,
        pendingKind: null,
      });
      const [history, response] = await Promise.all([
        this.client.history(runId, 0, undefined, this.abort.signal),
        this.client.query(runId, this.abort.signal),
      ]);
      this.update({ history });
      this.accept(response);
    });
  }

  public refresh(): Promise<void> {
    const runId = this.state.runId;
    return runId === null ? Promise.resolve() : this.select(runId);
  }

  public nextHistory(): Promise<void> {
    const { history, runId } = this.state;
    if (runId === null || history?.nextSequence == null) return Promise.resolve();
    const after = history.nextSequence;
    return this.perform(async () => {
      this.update({
        history: await this.client.history(
          runId,
          after,
          history.throughSequence,
          this.abort.signal,
        ),
      });
    });
  }

  public edit(draft: EvaluationDraft): void {
    if (this.state.busy || this.state.uncertain || this.state.evaluation?.state !== "draft") return;
    this.update({ draft });
  }

  public generate(): Promise<void> {
    const { runId, evaluation } = this.state;
    if (runId === null || evaluation?.state === "queued" || evaluation?.state === "running")
      return Promise.resolve();
    return this.perform(async () => {
      if (this.pending?.kind === "approve") return;
      this.pending ??= {
        kind: "generate",
        key: this.createKey(),
        expectedId: evaluation?.evaluationId ?? null,
      };
      this.update({ uncertain: true, pendingKind: "generate" });
      this.accept(
        await this.client.generate(
          runId,
          this.pending.expectedId,
          this.pending.key,
          this.abort.signal,
        ),
      );
    });
  }

  public approve(): Promise<void> {
    const { runId, evaluation, draft } = this.state;
    if (runId === null || evaluation?.state !== "draft" || draft === null) return Promise.resolve();
    return this.perform(async () => {
      if (this.pending?.kind === "generate") return;
      const parsed = EvaluationDraftSchema.parse({
        ...draft,
        difficulties: draft.difficulties.map((item) => item.trim()).filter(Boolean),
      });
      this.pending ??= {
        kind: "approve",
        key: this.createKey(),
        evaluationId: evaluation.evaluationId,
        draft: parsed,
      };
      this.update({ uncertain: true, pendingKind: "approve" });
      this.accept(
        await this.client.approve(
          runId,
          this.pending.evaluationId,
          this.pending.draft,
          this.pending.key,
          this.abort.signal,
        ),
      );
    });
  }

  public dispose(): void {
    this.abort.abort();
  }

  private accept(response: EvaluationResponse): void {
    const evaluation = response.evaluation;
    this.pending = undefined;
    this.update({
      evaluation,
      uncertain: false,
      pendingKind: null,
      draft: evaluation !== null && "draft" in evaluation ? evaluation.draft : null,
    });
  }

  private async perform(operation: () => Promise<void>): Promise<void> {
    if (this.state.busy || this.abort.signal.aborted) return;
    this.update({ busy: true, error: false });
    try {
      await operation();
    } catch {
      this.update({ error: true });
    } finally {
      this.update({ busy: false });
    }
  }

  private update(patch: Partial<EvaluationState>): void {
    if (this.abort.signal.aborted) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    this.changed(this.state);
  }
}
