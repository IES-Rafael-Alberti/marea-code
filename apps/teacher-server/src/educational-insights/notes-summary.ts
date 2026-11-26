import * as z from "zod";
import { MAX_LEARNING_NOTES_CHARACTERS } from "@marea/protocol";
import type { PrivateProviderRoute } from "../sessions/contracts.js";
import type { EducationalRoute } from "./configuration.js";
import { InsightsFailure } from "./model-output.boundary.js";

/** Spanish instructions: the notes, the teacher and the tutor all work in Spanish first. */
function instructions(purpose: "session" | "teacher"): string {
  return {
    session: `Estas son notas de seguimiento de un alumno, escritas o revisadas por su docente y agrupadas por criterio. Resume lo más relevante para la sesión de tutoría de hoy y conserva la etiqueta de cada criterio. El resumen es contexto privado para el tutor: no reveles notas privadas al alumno ni presentes los niveles como calificaciones. Sé breve y no inventes información.`,
    teacher: `Estas son las notas de seguimiento de un alumno para un criterio, escritas o revisadas por su docente, una por línea y con fecha cuando la tienen. Propón un resumen breve, en español, que conserve lo más útil para las próximas sesiones y la fecha más reciente que lo justifique. El docente lo revisará antes de guardarlo. No presentes los niveles como calificaciones y no inventes información.`,
  }[purpose];
}

/**
 * The model and budget a notes summary uses: the given selection of the class route with the
 * route's evaluation budget, exactly as an evaluation would. A route without budget cannot ask.
 */
export function summaryRoute(
  route: PrivateProviderRoute,
  selection: { readonly providerId: string; readonly model: string },
): EducationalRoute {
  const budget = route.budget;
  if (budget === undefined) throw new InsightsFailure("unconfigured");
  return {
    providerId: selection.providerId,
    model: selection.model,
    budget: budget.evaluation,
    inputTokenCeiling: budget.inputTokenCeiling,
  };
}

/** The part of the educational inference a summary needs. */
export interface SummaryInference {
  generate(
    route: EducationalRoute,
    accountId: string,
    system: string,
    material: object,
    schema: z.ZodType<{ readonly summary: string }>,
    signal: AbortSignal,
  ): Promise<{ readonly summary: string }>;
}

/** Asks the model for a summary through the budgeted educational inference path. */
export async function summarizeNotes(
  inference: SummaryInference,
  route: EducationalRoute,
  accountId: string,
  purpose: "session" | "teacher",
  notes: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await inference.generate(
    route,
    accountId,
    instructions(purpose),
    { notes },
    z.object({ summary: z.string().trim().min(1).max(MAX_LEARNING_NOTES_CHARACTERS) }),
    signal,
  );
  return result.summary;
}
