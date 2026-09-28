import type {
  InferenceProviderEvent,
  InferenceProviderRequest,
} from "../../packages/plugin-api/src/index.js";
import { StudentRunSnapshotSchema } from "../../packages/protocol/src/index.js";
import { teachingConfiguration } from "../../apps/teacher-server/test-support/teaching-fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../apps/teacher-server/test-support/usage-fixture.js";
import { createAcceptanceHarness } from "../acceptance/harness.js";
import { DeterministicInferenceProvider } from "../acceptance/inference.js";

export const ACCEPTANCE_EVALUATION = {
  studentFeedback: "You identified a boundary. Add an empty-input example.",
  teacherNote: "Private evaluation observation — never for the student.",
  difficulties: ["Private failure-case observation."],
  criteria: [],
};

export class EvaluationAcceptanceProvider extends DeterministicInferenceProvider {
  readonly entered = Promise.withResolvers<undefined>();
  readonly gate = Promise.withResolvers<undefined>();

  override async *stream(request: InferenceProviderRequest): AsyncIterable<InferenceProviderEvent> {
    this.requests.push(request);
    this.entered.resolve(undefined);
    await this.gate.promise;
    yield { type: "text-delta", text: JSON.stringify(ACCEPTANCE_EVALUATION) };
    yield { type: "usage", inputTokens: 100, outputTokens: 50 };
    yield { type: "completed", finishReason: "stop" };
  }
}

export function evaluationAcceptanceHarness(dashboardAssets?: (request: Request) => Response) {
  const provider = new EvaluationAcceptanceProvider();
  const configuration = teachingConfiguration("free");
  return createAcceptanceHarness({
    ...(dashboardAssets === undefined ? {} : { dashboardAssets }),
    provider,
    evaluationIntervalMs: 10,
    snapshotSource: () => ({
      capture(snapshotId) {
        return {
          snapshot: StudentRunSnapshotSchema.parse({
            ...configuration.publicTemplate,
            id: snapshotId,
          }),
          teaching: { ...configuration.content, automaticEvaluation: true },
          providerRoute: {
            model: "deterministic-upstream",
            providerId: "test.deterministic",
            budget: SYNTHETIC_ROUTE_BUDGET,
          },
        };
      },
    }),
  }).then((harness) => ({ ...harness, provider }));
}
