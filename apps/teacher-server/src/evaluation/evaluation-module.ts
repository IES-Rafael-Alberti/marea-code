import type { IdGenerator } from "../identity/contracts.js";
import type { EvaluationRepository } from "./contracts.js";
import {
  EvaluationDraftGenerator,
  type DraftGeneratorOptions,
} from "./draft-generator.boundary.js";
import { EvaluationRuntime } from "./evaluation-runtime.boundary.js";
import { EvaluationService } from "./evaluation-service.js";
import { EvaluationWorker } from "./evaluation-worker.js";

export interface EvaluationModuleOptions extends DraftGeneratorOptions {
  readonly repository: EvaluationRepository;
  readonly ids: IdGenerator;
  readonly intervalMs: number;
  readonly onError: () => void;
}

/** Compose once per server. Start after exclusive recovery, stop before closing storage. */
export function createEvaluationModule(options: EvaluationModuleOptions) {
  const worker = new EvaluationWorker({
    repository: options.repository,
    generator: new EvaluationDraftGenerator(options),
    clock: options.clock,
    ids: options.ids,
  });
  const runtime = new EvaluationRuntime({
    worker,
    intervalMs: options.intervalMs,
    onError: options.onError,
  });
  let started = false;
  return Object.freeze({
    service: new EvaluationService(options),
    /** Only the exclusive database-owning bootstrap may call this, before serving requests.
     * This also settles unfinished usage reservations as unknown, never refunds them.
     */
    recoverAfterExclusiveStartup(): void {
      if (started) throw new Error("Recovery must precede evaluation startup.");
      const now = options.clock.now();
      options.ledger.recoverUnfinished(now);
      options.repository.recoverInterrupted(now);
    },
    start(): void {
      started = true;
      runtime.start();
    },
    stop(): Promise<void> {
      return runtime.stop();
    },
  });
}
