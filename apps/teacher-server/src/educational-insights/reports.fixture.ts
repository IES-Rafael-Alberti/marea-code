import { vi } from "vitest";
import type { InferenceProvider, InferenceProviderRequest } from "@marea/plugin-api";
import { EvaluationDraftSchema } from "@marea/protocol";
import type { fixture } from "./insights.fixture.js";
import { NOW, EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";
import { InputSchema } from "./reports-model.js";
import { EducationalInference } from "./inference.js";
import { ClassReports } from "./reports.js";
export function query(f: ReturnType<typeof fixture>, extra: object = {}) {
  const q = f.query({
    kind: "generate",
    from: "2026-01-01T00:00:00.000Z",
    to: NOW,
    locale: "en",
    ...extra,
  });
  if (q.kind !== "generate") throw new Error("query");
  return q;
}
export function input(f: ReturnType<typeof fixture>, id: string) {
  return InputSchema.parse(
    JSON.parse(
      String(
        f.database.readOne("SELECT input_json FROM marea_class_reports WHERE id = ?1", [id])
          ?.input_json,
      ),
    ),
  );
}
export function save(f: ReturnType<typeof fixture>, id: string, value: ReturnType<typeof input>) {
  f.database.execute("UPDATE marea_class_reports SET input_json = ?2 WHERE id = ?1", [
    id,
    JSON.stringify(value),
  ]);
}

export type FixtureSource = ReturnType<typeof input>["sources"][number];

/** Replaces the frozen sources of a queued report. */
export function replaceSources(
  f: ReturnType<typeof fixture>,
  id: string,
  change: (sources: FixtureSource[]) => FixtureSource[],
) {
  const frozen = input(f, id);
  save(f, id, { ...frozen, sources: change([...frozen.sources]) });
}

/** A provider that answers each request with the text `respond` returns, or fails with the error. */
export function textProvider(
  respond: (request: InferenceProviderRequest, call: number) => string | Error,
): InferenceProvider {
  let call = 0;
  return {
    async *stream(request) {
      await Promise.resolve();
      const answer = respond(request, ++call);
      if (answer instanceof Error) throw answer;
      yield { type: "text-delta", text: answer };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "completed", finishReason: "stop" };
    },
  };
}

/** Report processing wired to a scripted provider through the real inference layer. */
export function reportsWith(f: ReturnType<typeof fixture>, provider: InferenceProvider) {
  const inference = new EducationalInference(
    f.database,
    { resolve: () => provider },
    f.service.clock,
  );
  inference.retryDelayMs = 0;
  const reports = new ClassReports(
    f.progress,
    inference,
    f.service.clock,
    f.service.configuration.reports,
  );
  reports.diagnostics = f.diagnostics;
  return { reports, inference };
}

/** Raises the input ceiling of the report route, which also bounds the material kept per run. */
export function useCeiling(f: ReturnType<typeof fixture>, ceiling: number) {
  f.service.reports.route = {
    ...f.route,
    budget: { ...f.route.budget, maxInputTokens: ceiling },
    inputTokenCeiling: ceiling,
  };
}

export function observedDraft(source: ReturnType<typeof input>["sources"][number]) {
  return EvaluationDraftSchema.parse({
    ...EVALUATION_DRAFT,
    criteria: source.teaching.didacticSkills.flatMap((skill) =>
      skill.criteria.map((criterion) => ({
        skillId: skill.id,
        code: criterion.code,
        result: "passed",
        confidence: "high",
        evidence: "Observed",
      })),
    ),
  });
}
export async function pendingReportModel(f: ReturnType<typeof fixture>) {
  const pending = Promise.withResolvers<never>();
  const generate = vi.spyOn(f.service.inference, "generate").mockReturnValue(pending.promise);
  const tick = f.service.reports.tick();
  await vi.waitFor(() => {
    if (generate.mock.calls.length !== 1) throw new Error("Waiting for model");
  });
  return { pending, generate, tick };
}
