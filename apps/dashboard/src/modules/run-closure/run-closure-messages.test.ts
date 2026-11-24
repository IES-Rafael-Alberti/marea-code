import { describe, expect, it } from "vitest";

import { runClosureMessages } from "./run-closure-messages.js";

describe("run closure messages", () => {
  it("offers the same wording in every supported language", () => {
    const keys = Object.keys(runClosureMessages("en")).toSorted();
    expect(Object.keys(runClosureMessages("es")).toSorted()).toEqual(keys);
    expect(Object.keys(runClosureMessages("eu")).toSorted()).toEqual(keys);
    expect(runClosureMessages("en")).not.toBe(runClosureMessages("es"));
    expect(runClosureMessages("eu")).not.toBe(runClosureMessages("es"));
  });

  it("names the student and says what ending a session means", () => {
    const en = runClosureMessages("en");
    expect(en.endSession).toBe("End session");
    expect(en.endAllSessions).toBe("End all sessions");
    expect(en.oneBody("Ana")).toContain("Ana");
    expect(en.onePending("Ana")).toBe(
      "Ana has an approval pending. Ending the session discards it.",
    );
    expect(en.classPending("Ana, Ben")).toContain("Ana, Ben");
    expect(runClosureMessages("es").oneBody("Ana")).toContain("Ana");
    expect(runClosureMessages("es").onePending("Ana")).toContain("Ana");
    expect(runClosureMessages("eu").oneBody("Ana")).toContain("Ana");
    expect(runClosureMessages("eu").onePending("Ana")).toContain("Ana");
    expect(runClosureMessages("es").classPending("Ana")).toContain("Ana");
    expect(runClosureMessages("eu").classPending("Ana")).toContain("Ana");
  });

  it("counts the sessions in the class dialog in every language", () => {
    const en = runClosureMessages("en");
    expect([en.classTitle(1), en.classTitle(3)]).toEqual(["End 1 session?", "End 3 sessions?"]);
    expect([en.confirmClass(1), en.confirmClass(3)]).toEqual(["End 1 session", "End 3 sessions"]);
    const es = runClosureMessages("es");
    expect([es.classTitle(1), es.classTitle(3)]).toEqual([
      "¿Finalizar 1 sesión?",
      "¿Finalizar 3 sesiones?",
    ]);
    expect([es.confirmClass(1), es.confirmClass(3)]).toEqual([
      "Finalizar 1 sesión",
      "Finalizar 3 sesiones",
    ]);
    const eu = runClosureMessages("eu");
    expect(eu.classTitle(1)).toContain("1");
    expect(eu.classTitle(4)).toContain("4");
    expect([eu.confirmClass(1), eu.confirmClass(4)]).toEqual(["Amaitu 1 saio", "Amaitu 4 saio"]);
  });

  it("tells the teacher that automatic evaluation follows the class setting", () => {
    expect(runClosureMessages("en").evaluationNote).toContain("automatic evaluation is enabled");
    expect(runClosureMessages("es").evaluationNote).toContain("evaluación automática");
    expect(runClosureMessages("eu").evaluationNote).toContain("ebaluazio automatikoa");
  });

  it.each([
    [
      "en",
      {
        endSession: "End session",
        endAllSessions: "End all sessions",
        cancel: "Cancel",
        ending: "Ending…",
        failed: "The sessions could not be ended. Check the connection and try again.",
        oneTitle: "End this session?",
        oneBody:
          "Ana will be told that you ended the session and can start a new one by running Marea again.",
        onePending: "Ana has an approval pending. Ending the session discards it.",
        classTitle: ["End 1 session?", "End 2 sessions?"],
        classBody:
          "These students will be told that you ended the session and can start a new one by running Marea again.",
        classPending:
          "These students have an approval pending, which ending the session discards: Ana, Ben.",
        evaluationNote:
          "If automatic evaluation is enabled for the class, the evaluation starts after the session ends.",
        confirmOne: "End this session",
        confirmClass: ["End 1 session", "End 2 sessions"],
      },
    ],
    [
      "es",
      {
        endSession: "Finalizar sesión",
        endAllSessions: "Finalizar todas las sesiones",
        cancel: "Cancelar",
        ending: "Finalizando…",
        failed:
          "No se pudieron finalizar las sesiones. Comprueba la conexión e inténtalo de nuevo.",
        oneTitle: "¿Finalizar esta sesión?",
        oneBody:
          "Ana verá que has finalizado la sesión y podrá empezar otra ejecutando Marea de nuevo.",
        onePending: "Ana tiene una autorización pendiente. Al finalizar la sesión se descarta.",
        classTitle: ["¿Finalizar 1 sesión?", "¿Finalizar 2 sesiones?"],
        classBody:
          "Estos estudiantes verán que has finalizado la sesión y podrán empezar otra ejecutando Marea de nuevo.",
        classPending:
          "Estos estudiantes tienen una autorización pendiente, que se descarta al finalizar la sesión: Ana, Ben.",
        evaluationNote:
          "Si la clase tiene activada la evaluación automática, la evaluación empieza cuando termina la sesión.",
        confirmOne: "Finalizar esta sesión",
        confirmClass: ["Finalizar 1 sesión", "Finalizar 2 sesiones"],
      },
    ],
    [
      "eu",
      {
        endSession: "Amaitu saioa",
        endAllSessions: "Amaitu saio guztiak",
        cancel: "Utzi",
        ending: "Amaitzen…",
        failed: "Ezin izan dira saioak amaitu. Egiaztatu konexioa eta saiatu berriro.",
        oneTitle: "Saio hau amaitu nahi duzu?",
        oneBody:
          "Ana ikasleak ikusiko du saioa amaitu duzula, eta Marea berriro exekutatuz beste bat hasi ahalko du.",
        onePending: "Ana ikasleak baimen bat dauka zain. Saioa amaitzean baztertu egiten da.",
        classTitle: ["1 saio amaitu nahi duzu?", "2 saio amaitu nahi dituzu?"],
        classBody:
          "Ikasle hauek ikusiko dute saioa amaitu duzula, eta Marea berriro exekutatuz beste bat hasi ahalko dute.",
        classPending:
          "Ikasle hauek baimen bat dute zain, saioa amaitzean baztertzen dena: Ana, Ben.",
        evaluationNote:
          "Ikasgelak ebaluazio automatikoa gaituta badu, ebaluazioa saioa amaitzean hasiko da.",
        confirmOne: "Amaitu saio hau",
        confirmClass: ["Amaitu 1 saio", "Amaitu 2 saio"],
      },
    ],
  ] as const)("publishes the exact %s wording", (locale, expected) => {
    const m = runClosureMessages(locale);
    expect({
      endSession: m.endSession,
      endAllSessions: m.endAllSessions,
      cancel: m.cancel,
      ending: m.ending,
      failed: m.failed,
      oneTitle: m.oneTitle,
      oneBody: m.oneBody("Ana"),
      onePending: m.onePending("Ana"),
      classTitle: [m.classTitle(1), m.classTitle(2)],
      classBody: m.classBody,
      classPending: m.classPending("Ana, Ben"),
      evaluationNote: m.evaluationNote,
      confirmOne: m.confirmOne,
      confirmClass: [m.confirmClass(1), m.confirmClass(2)],
    }).toEqual(expected);
  });
});
