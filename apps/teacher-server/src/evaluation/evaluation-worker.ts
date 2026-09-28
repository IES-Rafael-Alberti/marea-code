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
