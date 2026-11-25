import { formatPlural, type Locale } from "@marea/i18n";

interface Copy {
  readonly endSession: string;
  readonly endAllSessions: string;
  readonly cancel: string;
  readonly ending: string;
  readonly failed: string;
  readonly offline: string;
  readonly unavailable: string;
  readonly forbidden: string;
  readonly expired: string;
  readonly serverFailed: (requestId: string) => string;
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

function en(): Copy {
  return {
    endSession: "End session",
    endAllSessions: "End all sessions",
    cancel: "Cancel",
    ending: "Ending…",
    failed: "The sessions could not be ended. Check the connection and try again.",
    offline: "The server cannot be reached. Check the network and try again.",
    unavailable:
      "This session is no longer available; it may have ended already. Refresh the page to see its current state.",
    forbidden: "You do not have permission to end these sessions.",
    expired: "Your dashboard session has expired. Sign in again and retry.",
    serverFailed: (requestId: string) =>
      `The server could not end the sessions. Try again; if it happens again, give the server administrator this reference: ${requestId}.`,
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
  };
}

function es(): Copy {
  return {
    endSession: "Finalizar sesión",
    endAllSessions: "Finalizar todas las sesiones",
    cancel: "Cancelar",
    ending: "Finalizando…",
    failed: "No se pudieron finalizar las sesiones. Comprueba la conexión e inténtalo de nuevo.",
    offline: "No hay conexión con el servidor. Comprueba la red e inténtalo de nuevo.",
    unavailable:
      "Esta sesión ya no está disponible; puede que ya haya terminado. Actualiza la página para ver su estado.",
    forbidden: "No tienes permiso para finalizar estas sesiones.",
    expired: "Tu sesión del panel ha caducado. Vuelve a iniciar sesión e inténtalo de nuevo.",
    serverFailed: (requestId: string) =>
      `El servidor no pudo finalizar las sesiones. Inténtalo de nuevo; si se repite, da a quien administra el servidor esta referencia: ${requestId}.`,
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
  };
}

function eu(): Copy {
  return {
    endSession: "Amaitu saioa",
    endAllSessions: "Amaitu saio guztiak",
    cancel: "Utzi",
    ending: "Amaitzen…",
    failed: "Ezin izan dira saioak amaitu. Egiaztatu konexioa eta saiatu berriro.",
    offline: "Ezin da zerbitzarira konektatu. Egiaztatu sarea eta saiatu berriro.",
    unavailable:
      "Saio hau ez dago erabilgarri; baliteke dagoeneko amaitu izana. Freskatu orria bere egoera ikusteko.",
    forbidden: "Ez duzu saio hauek amaitzeko baimenik.",
    expired: "Panelaren saioa iraungi da. Hasi saioa berriro eta saiatu berriro.",
    serverFailed: (requestId: string) =>
      `Zerbitzariak ezin izan ditu saioak amaitu. Saiatu berriro; berriz gertatzen bada, eman erreferentzia hau zerbitzariaren administratzaileari: ${requestId}.`,
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
  };
}

export function runClosureMessages(locale: Locale): RunClosureMessages {
  return locale === "en" ? en() : locale === "eu" ? eu() : es();
}
