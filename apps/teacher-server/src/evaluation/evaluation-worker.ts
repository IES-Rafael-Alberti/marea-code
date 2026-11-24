import type { EvaluationDraft, EvaluationFailure } from "@marea/protocol";

import type { Clock, IdGenerator } from "../identity/contracts.js";
import type { EvaluationClaim, EvaluationRepository } from "./contracts.js";
import { EvaluationGenerationError } from "./generation-error.js";

export interface EvaluationWorkerOptions {
  readonly repository: EvaluationRepository;
  readonly generator: {
    generate(claim: EvaluationClaim, signal: AbortSignal): Promise<EvaluationDraft>;
  };
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Evaluations processed in parallel by one tick. Each keeps its own per-run budget. */
export const EVALUATION_CONCURRENCY = 4;

/** The host schedules bounded ticks; generation never runs in the session-close request. */
export class EvaluationWorker {
  public constructor(private readonly options: EvaluationWorkerOptions) {}

  public discoverClosedRuns(): number {
    let queued = 0;
    for (const runId of this.options.repository.automaticCandidates()) {
      const result = this.options.repository.queueAutomatic(
        runId,
        this.options.ids.createId("event"),
        this.options.clock.now(),
      );
      if (result !== null) queued += 1;
    }
    return queued;
  }

  /**
   * Claims and evaluates up to `EVALUATION_CONCURRENCY` queued evaluations at once. Every claim
   * is one atomic repository statement, so two workers never receive the same evaluation, and
   * the batch settles completely before it reports a failure so a stop never leaves one running.
   */
  public async runBatch(signal: AbortSignal): Promise<number> {
    const settled = await Promise.allSettled(
      Array.from({ length: EVALUATION_CONCURRENCY }, () => this.runNext(signal)),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
    return settled.filter((result) => result.status === "fulfilled" && result.value).length;
  }

  public async runNext(signal: AbortSignal): Promise<boolean> {
    const cancelled = () => signal.aborted;
    if (cancelled()) return false;
    const claim = this.options.repository.claim(
      this.options.ids.createId("event"),
      this.options.clock.now(),
    );
    if (claim === null) return false;
    let result: EvaluationDraft | EvaluationFailure;
    try {
      result = await this.options.generator.generate(claim, signal);
      if (cancelled()) result = "interrupted";
    } catch (error) {
      result = cancelled()
        ? "interrupted"
        : error instanceof EvaluationGenerationError
          ? error.code
          : "inference-failed";
    }
    this.options.repository.finish(claim, result, this.options.clock.now());
    return true;
  }
}
