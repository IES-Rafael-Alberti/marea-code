import { formatPlural, type Locale } from "@marea/i18n";

interface Copy {
  readonly endSession: string;
  readonly endAllSessions: string;
  readonly cancel: string;
  readonly ending: string;
  readonly failed: string;
  readonly oneTitle: string;
  readonly oneBody: (student: string) => string;
  readonly onePending: (student: string) => string;
  readonly classTitle: (count: number) => string;
  readonly classBody: string;
  readonly classPending: (students: string) => string;
  readonly evaluationNote: string;
  readonly confirmOne: string;
  readonly confirmClass: (count: number) => string;
}

export type RunClosureMessages = Copy;

const en = {
  endSession: "End session",
  endAllSessions: "End all sessions",
  cancel: "Cancel",
  ending: "Ending…",
  failed: "The sessions could not be ended. Check the connection and try again.",
  oneTitle: "End this session?",
  oneBody: (student: string) =>
    `${student} will be told that you ended the session and can start a new one by running Marea again.`,
  onePending: (student: string) =>
    `${student} has an approval pending. Ending the session discards it.`,
  classTitle: (count: number) =>
    formatPlural("en", count, {
      one: `End ${String(count)} session?`,
      other: `End ${String(count)} sessions?`,
    }),
  classBody:
    "These students will be told that you ended the session and can start a new one by running Marea again.",
  classPending: (students: string) =>
    `These students have an approval pending, which ending the session discards: ${students}.`,
  evaluationNote:
    "If automatic evaluation is enabled for the class, the evaluation starts after the session ends.",
  confirmOne: "End this session",
  confirmClass: (count: number) =>
    formatPlural("en", count, {
      one: `End ${String(count)} session`,
      other: `End ${String(count)} sessions`,
    }),
} satisfies Copy;

const es = {
  endSession: "Finalizar sesión",
  endAllSessions: "Finalizar todas las sesiones",
  cancel: "Cancelar",
  ending: "Finalizando…",
  failed: "No se pudieron finalizar las sesiones. Comprueba la conexión e inténtalo de nuevo.",
  oneTitle: "¿Finalizar esta sesión?",
  oneBody: (student: string) =>
    `${student} verá que has finalizado la sesión y podrá empezar otra ejecutando Marea de nuevo.`,
  onePending: (student: string) =>
    `${student} tiene una autorización pendiente. Al finalizar la sesión se descarta.`,
  classTitle: (count: number) =>
    formatPlural("es", count, {
      one: `¿Finalizar ${String(count)} sesión?`,
      other: `¿Finalizar ${String(count)} sesiones?`,
    }),
  classBody:
    "Estos estudiantes verán que has finalizado la sesión y podrán empezar otra ejecutando Marea de nuevo.",
  classPending: (students: string) =>
    `Estos estudiantes tienen una autorización pendiente, que se descarta al finalizar la sesión: ${students}.`,
  evaluationNote:
    "Si la clase tiene activada la evaluación automática, la evaluación empieza cuando termina la sesión.",
  confirmOne: "Finalizar esta sesión",
  confirmClass: (count: number) =>
    formatPlural("es", count, {
      one: `Finalizar ${String(count)} sesión`,
      other: `Finalizar ${String(count)} sesiones`,
    }),
} satisfies Copy;

const eu = {
  endSession: "Amaitu saioa",
  endAllSessions: "Amaitu saio guztiak",
  cancel: "Utzi",
  ending: "Amaitzen…",
  failed: "Ezin izan dira saioak amaitu. Egiaztatu konexioa eta saiatu berriro.",
  oneTitle: "Saio hau amaitu nahi duzu?",
  oneBody: (student: string) =>
    `${student} ikasleak ikusiko du saioa amaitu duzula, eta Marea berriro exekutatuz beste bat hasi ahalko du.`,
  onePending: (student: string) =>
    `${student} ikasleak baimen bat dauka zain. Saioa amaitzean baztertu egiten da.`,
  classTitle: (count: number) =>
    formatPlural("eu", count, {
      one: `${String(count)} saio amaitu nahi duzu?`,
      other: `${String(count)} saio amaitu nahi dituzu?`,
    }),
  classBody:
    "Ikasle hauek ikusiko dute saioa amaitu duzula, eta Marea berriro exekutatuz beste bat hasi ahalko dute.",
  classPending: (students: string) =>
    `Ikasle hauek baimen bat dute zain, saioa amaitzean baztertzen dena: ${students}.`,
  evaluationNote:
    "Ikasgelak ebaluazio automatikoa gaituta badu, ebaluazioa saioa amaitzean hasiko da.",
  confirmOne: "Amaitu saio hau",
  confirmClass: (count: number) =>
    formatPlural("eu", count, {
      one: `Amaitu ${String(count)} saio`,
      other: `Amaitu ${String(count)} saio`,
    }),
} satisfies Copy;

export const runClosureMessages = (locale: Locale): RunClosureMessages =>
  locale === "en" ? en : locale === "eu" ? eu : es;
