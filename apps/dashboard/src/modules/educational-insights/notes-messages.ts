import type { DashboardLocale } from "../../messages.js";

/** Built on each call, so every text is checked by the catalog snapshots. */
function es() {
  return {
    notes: "Notas de aprendizaje",
    notesHelp:
      "Historial privado que el tutor recibe en las próximas sesiones. Cada aprobación añade una línea con la fecha de la sesión; puedes corregirlo, resumirlo o vaciarlo.",
    save: "Guardar",
    cancel: "Cancelar",
    propose: "Proponer resumen",
    proposed: "Resumen propuesto: revísalo antes de guardar. No se ha guardado nada todavía.",
    long: "El historial de notas es muy largo; conviene resumirlo.",
    longSummary: "⚠ notas largas",
    tooLong: "El texto supera el máximo de 200 000 caracteres; acórtalo para poder guardarlo.",
    omitted:
      "Las notas más antiguas no se muestran porque el historial es demasiado largo; si guardas, el texto que ves sustituirá a todo el historial.",
    conflict: "Se ha añadido una nota nueva mientras editabas; revísala.",
    error: "No se pudieron cargar ni guardar las notas. Vuelve a intentarlo.",
    empty: "No hay notas que resumir.",
    unconfigured: "La clase no tiene un modelo configurado para proponer resúmenes.",
    budget: "Se ha agotado el presupuesto del modelo; inténtalo más tarde.",
    tooLarge: "Las notas son demasiado largas para el modelo; acórtalas a mano.",
    proposalFailed: "No se pudo proponer un resumen. El texto no ha cambiado.",
    count: (characters: number) => `${characters.toLocaleString("es-ES")} caracteres`,
    notice: (student: string, date: string, summarized: boolean) =>
      summarized
        ? `Las notas de ${student} no cabían; se resumieron automáticamente para la sesión del ${date}. Conviene resumirlas.`
        : `Las notas de ${student} no cabían; para la sesión del ${date} solo se usaron las más recientes. Conviene resumirlas.`,
  };
}
type Messages = ReturnType<typeof es>;
function en(): Messages {
  return {
    notes: "Learning notes",
    notesHelp:
      "Private history the tutor receives in the next sessions. Each approval adds a line with the session date; you can correct, summarize or clear it.",
    save: "Save",
    cancel: "Cancel",
    propose: "Propose summary",
    proposed: "Proposed summary: review it before saving. Nothing has been saved yet.",
    long: "The notes history is very long; consider summarizing it.",
    longSummary: "⚠ long notes",
    tooLong: "The text exceeds the 200,000-character maximum; shorten it to save.",
    omitted:
      "The oldest notes are not shown because the history is too long; if you save, the text you see replaces the whole history.",
    conflict: "A new note was added while you were editing; review it.",
    error: "The notes could not be loaded or saved. Try again.",
    empty: "There are no notes to summarize.",
    unconfigured: "The class has no model configured to propose summaries.",
    budget: "The model budget is exhausted; try again later.",
    tooLarge: "The notes are too long for the model; shorten them by hand.",
    proposalFailed: "A summary could not be proposed. The text has not changed.",
    count: (characters: number) => `${characters.toLocaleString("en-GB")} characters`,
    notice: (student: string, date: string, summarized: boolean) =>
      summarized
        ? `${student}'s notes did not fit; they were summarized automatically for the session of ${date}. Consider summarizing them.`
        : `${student}'s notes did not fit; only the most recent ones were used for the session of ${date}. Consider summarizing them.`,
  };
}
function eu(): Messages {
  return {
    notes: "Ikaskuntza-oharrak",
    notesHelp:
      "Tutoreak hurrengo saioetan jasotzen duen historia pribatua. Onarpen bakoitzak saioaren data duen lerro bat gehitzen du; zuzendu, laburtu edo hustu dezakezu.",
    save: "Gorde",
    cancel: "Utzi",
    propose: "Proposatu laburpena",
    proposed: "Proposatutako laburpena: berrikusi gorde aurretik. Oraindik ez da ezer gorde.",
    long: "Oharren historia oso luzea da; komeni da laburtzea.",
    longSummary: "⚠ ohar luzeak",
    tooLong: "Testuak 200 000 karaktereko muga gainditzen du; laburtu gorde ahal izateko.",
    omitted:
      "Ohar zaharrenak ez dira erakusten historia luzeegia delako; gordetzen baduzu, ikusten duzun testuak historia osoa ordeztuko du.",
    conflict: "Ohar berri bat gehitu da editatzen ari zinen bitartean; berrikusi.",
    error: "Ezin izan dira oharrak kargatu edo gorde. Saiatu berriro.",
    empty: "Ez dago laburtzeko oharrik.",
    unconfigured: "Gelak ez du laburpenak proposatzeko eredurik konfiguratuta.",
    budget: "Ereduaren aurrekontua agortu da; saiatu geroago.",
    tooLarge: "Oharrak luzeegiak dira eredurako; laburtu eskuz.",
    proposalFailed: "Ezin izan da laburpenik proposatu. Testua ez da aldatu.",
    count: (characters: number) => `${characters.toLocaleString("eu-ES")} karaktere`,
    notice: (student: string, date: string, summarized: boolean) =>
      summarized
        ? `${student}(r)en oharrak ez ziren sartzen; ${date} eguneko saiorako automatikoki laburtu ziren. Komeni da laburtzea.`
        : `${student}(r)en oharrak ez ziren sartzen; ${date} eguneko saioan berrienak bakarrik erabili ziren. Komeni da laburtzea.`,
  };
}

export function notesMessages(locale: DashboardLocale): Messages {
  return locale === "es" ? es() : locale === "eu" ? eu() : en();
}

/** The Spanish-first message for a closed proposal failure code. */
export function proposalFailure(m: Messages, failure: string | null): string {
  return failure === "empty"
    ? m.empty
    : failure === "unconfigured"
      ? m.unconfigured
      : failure === "budget"
        ? m.budget
        : failure === "input-too-large"
          ? m.tooLarge
          : m.proposalFailed;
}
