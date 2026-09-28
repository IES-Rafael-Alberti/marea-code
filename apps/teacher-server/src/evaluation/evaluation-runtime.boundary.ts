import type { EvaluationWorker } from "./evaluation-worker.js";

export interface EvaluationRuntimeOptions {
  readonly worker: Pick<EvaluationWorker, "discoverClosedRuns" | "runNext">;
  readonly intervalMs: number;
  /** Report only a safe operational status, never frozen evidence or provider errors. */
  readonly onError: () => void;
}

/** One serial worker per host. Stop and await it before closing the database.
 * Recovery of abandoned claims belongs to exclusive server bootstrap, not each worker start.
 */
export class EvaluationRuntime {
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> = Promise.resolve();

  public constructor(private readonly options: EvaluationRuntimeOptions) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1 ||
      options.intervalMs > 2_147_483_647
    )
      throw new TypeError(
        "The evaluation worker interval must be an integer from 1 to 2147483647.",
      );
  }

  public start(): void {
    if (this.controller !== undefined) return;
    this.controller = new AbortController();
    this.schedule(this.controller);
  }

  public async stop(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined) return;
    controller.abort();
    clearTimeout(this.timer);
    await this.active;
    this.controller = undefined;
  }

  private schedule(controller: AbortController): void {
    this.timer = setTimeout(() => {
      this.active = this.tick(controller);
    }, this.options.intervalMs);
  }

  private async tick(controller: AbortController): Promise<void> {
    try {
      this.options.worker.discoverClosedRuns();
      await this.options.worker.runNext(controller.signal);
    } catch {
      this.options.onError();
    } finally {
      if (!controller.signal.aborted) this.schedule(controller);
    }
  }
}
