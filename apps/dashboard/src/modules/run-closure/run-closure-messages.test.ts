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
});
