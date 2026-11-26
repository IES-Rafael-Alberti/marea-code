import type {
  InferenceCancellation,
  InferenceProviderEvent,
  InferenceProviderRequest,
} from "@marea/plugin-api";

import { EVALUATION_DRAFT, evaluationFixture, NOW } from "../../test-support/evaluation-fixture.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import { EvaluationDraftGenerator } from "./draft-generator.boundary.js";
import { EvaluationWorker } from "./evaluation-worker.js";
import type { EvaluationClaim } from "./contracts.js";
import type { EvaluationDraftDiagnostic } from "./generation-error.js";

/** A generator and worker over a frozen evaluation, streaming the given provider events. */
export function setup(
  events: readonly InferenceProviderEvent[],
  onRequest?: (signal: InferenceCancellation) => void,
  diagnostic?: (event: EvaluationDraftDiagnostic) => void,
) {
  const test = evaluationFixture();
  const requests: InferenceProviderRequest[] = [];
  const ledger = new SqliteUsageLedger(test.database);
  let id = 0;
  const clock = { now: () => NOW };
  const generator = new EvaluationDraftGenerator({
    diagnostic,
    ledger,
    clock,
    createReservationId: () => `reservation:${String(++id)}`,
    providers: {
      resolve: () => ({
        async *stream(request, signal) {
          requests.push(request);
          onRequest?.(signal);
          await Promise.resolve();
          yield* events;
        },
      }),
    },
  });
  const worker = new EvaluationWorker({
    repository: test.repository,
    generator,
    clock,
    ids: { createId: (namespace) => `${namespace}:${String(++id)}` },
  });
  return { ...test, requests, ledger, generator, worker };
}

export function response(
  text = JSON.stringify(EVALUATION_DRAFT),
  finishReason: "stop" | "length" = "stop",
): readonly InferenceProviderEvent[] {
  return [
    { type: "text-delta", text: text.slice(0, 17) },
    { type: "text-delta", text: text.slice(17) },
    { type: "usage", inputTokens: 10, outputTokens: 20 },
    { type: "completed", finishReason },
  ];
}

export function requireClaim(claim: EvaluationClaim | null): EvaluationClaim {
  if (claim === null) throw new Error("Expected evaluation claim.");
  return claim;
}
