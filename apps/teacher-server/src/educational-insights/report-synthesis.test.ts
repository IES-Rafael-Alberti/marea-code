import { expect, it, vi } from "vitest";
import type * as z from "zod";
import { synthesize } from "./report-synthesis.js";
import {
  PROMPT_RESERVE_BYTES,
  SYNTHESIZE,
  type Evidence,
  type InputSchema,
} from "./reports-model.js";
import { ModelSynthesisSchema } from "./report-findings.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";

type Input = z.infer<typeof InputSchema>;
const limited = SYNTHETIC_ROUTE_BUDGET.evaluation;
const route = (ceiling: number, unlimited = false): Input["route"] => ({
  providerId: "p",
  model: "m",
  budget: unlimited
    ? { ...limited, unlimited: true, maxRequests: 0, maxTokens: 0, maxCostUnits: 0 }
    : limited,
  inputTokenCeiling: ceiling,
});
const input = (r: Input["route"], locale: Input["locale"] = "en"): Input => ({
  from: "a",
  to: "b",
  locale,
  sources: [],
  route: r,
});
const evidence = (alias: string): Evidence => ({
  runId: `run:${alias}`,
  alias,
  mode: "tutoring",
  skills: [],
  status: "provisional",
  evaluation: { ...EVALUATION_DRAFT, teacherNote: "note", difficulties: ["d"] },
});
const stub = () => {
  const generate = vi.fn().mockResolvedValue({ synthesis: "x", dropped: 0 });
  return { inference: { generate }, generate };
};
const signal = () => new AbortController().signal;
const firstDossier = (generate: ReturnType<typeof vi.fn>) =>
  (generate.mock.calls[0]?.[3] as { evidence: { note?: string }[] }).evidence[0];

it.each([
  ["es", "No hay evidencia suficiente para generar el informe."],
  ["eu", "Ez dago txostena sortzeko nahikoa ebidentziarik."],
  ["en", "Insufficient evidence to generate a report."],
] as const)("answers without a model call when nothing is usable (%s)", async (locale, summary) => {
  const { inference, generate } = stub();
  const result = await synthesize(inference, input(route(1), locale), "a", [], signal());
  expect(result).toStrictEqual({
    synthesis: { summary, findings: [], recommendation: "" },
    dropped: 0,
  });
  expect(generate).not.toHaveBeenCalled();
});

it("sends full detail without a ceiling and reduced detail when it is tight", async () => {
  const many = Array.from({ length: 30 }, (_v, i) => evidence(`A${String(i)}`));
  const unlimited = stub();
  await synthesize(unlimited.inference, input(route(1, true)), "acc", many, signal());
  expect(firstDossier(unlimited.generate)).toMatchObject({ note: "note", difficulties: ["d"] });
  const tight = stub();
  const tightRoute = route(PROMPT_RESERVE_BYTES + 1);
  await synthesize(tight.inference, input(tightRoute), "acc", many, signal());
  expect(firstDossier(tight.generate)).not.toHaveProperty("note");
  expect(tight.generate.mock.calls[0]?.slice(0, 3)).toEqual([tightRoute, "acc", SYNTHESIZE]);
  expect(tight.generate.mock.calls[0]?.[4]).toBe(ModelSynthesisSchema);
});
