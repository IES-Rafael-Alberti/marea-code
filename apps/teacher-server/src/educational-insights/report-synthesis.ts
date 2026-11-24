import type * as z from "zod";
import { ReportSynthesisSchema, type ReportSynthesis } from "@marea/protocol";
import type { EducationalInference } from "./inference.js";
import { compactEvidence, ModelSynthesisSchema } from "./report-findings.js";
import { SYNTHESIZE, type Evidence, type InputSchema } from "./reports-model.js";

const NO_EVIDENCE = {
  es: "No hay evidencia suficiente para generar el informe.",
  eu: "Ez dago txostena sortzeko nahikoa ebidentziarik.",
  en: "Insufficient evidence to generate a report.",
} as const;

/** One synthesis call over compact dossiers; without usable evidence there is nothing to ask. */
export async function synthesize(
  inference: EducationalInference,
  input: z.infer<typeof InputSchema>,
  accountId: string,
  usable: readonly Evidence[],
  signal: AbortSignal,
): Promise<{ readonly synthesis: ReportSynthesis; readonly dropped: number }> {
  if (usable.length === 0)
    return {
      synthesis: { summary: NO_EVIDENCE[input.locale], findings: [], recommendation: "" },
      dropped: 0,
    };
  const ceiling = input.route.budget.unlimited === true ? null : input.route.inputTokenCeiling;
  return inference.generate(
    input.route,
    accountId,
    SYNTHESIZE,
    { locale: input.locale, evidence: compactEvidence(usable, ceiling) },
    ModelSynthesisSchema,
    signal,
    ReportSynthesisSchema,
  );
}
