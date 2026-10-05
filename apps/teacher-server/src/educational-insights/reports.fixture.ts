import { vi } from "vitest";
import { EvaluationDraftSchema } from "@marea/protocol";
import type { fixture } from "./insights.fixture.js";
import { NOW, EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";
import { InputSchema } from "./reports-model.js";
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
