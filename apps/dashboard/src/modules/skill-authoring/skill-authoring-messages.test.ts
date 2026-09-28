import { describe, expect, it } from "vitest";

import { skillAuthoringMessages, type SkillAuthoringMessages } from "./skill-authoring-messages.js";

function expectStaticCopy(messages: SkillAuthoringMessages): void {
  for (const value of Object.values(messages)) {
    if (typeof value === "string") expect(value.length).toBeGreaterThan(0);
  }
  expect(Object.keys(messages.errors)).toEqual([
    "load",
    "invalid",
    "forbidden",
    "conflict",
    "uncertain",
    "skill-unavailable",
  ]);
  expect(Object.values(messages.errors).every((value) => value.length > 0)).toBe(true);
  expect(Object.keys(messages.status)).toEqual(["current", "stale", "missing"]);
  expect(Object.values(messages.status).every((value) => value.length > 0)).toBe(true);
}

describe("skill authoring messages", () => {
  it("keeps complete English and Spanish copy with locale-specific templates", () => {
    const english = skillAuthoringMessages("en");
    const spanish = skillAuthoringMessages("es");
    expect(english.heading).toBe("Skill authoring");
    expect(spanish.heading).toBe("Edición de skills");
    expect(english.skillIdentity).toBe("Skill identity");
    expect(spanish.skillIdentity).toBe("Identidad de la skill");
    expectStaticCopy(english);
    expectStaticCopy(spanish);
    expect(english.exportSaved("resources/lesson.txt")).toBe("Export saved resources/lesson.txt");
    expect(english.exportDraft("resources/lesson.txt")).toBe("Export draft resources/lesson.txt");
    expect(english.copySource("marea/bundled")).toBe("Copy source marea/bundled");
    expect(english.pendingPrompt("class:one")).toBe(
      "Switch to class:one? Unsaved draft changes will be lost.",
    );
    expect(spanish.exportSaved("resources/lesson.txt")).toBe(
      "Exportar resources/lesson.txt guardado",
    );
    expect(spanish.exportDraft("resources/lesson.txt")).toBe(
      "Exportar resources/lesson.txt del borrador",
    );
    expect(spanish.copySource("marea/bundled")).toBe("Origen de copia marea/bundled");
    expect(spanish.pendingPrompt("class:one")).toBe(
      "¿Cambiar a class:one? Se perderán los cambios sin guardar.",
    );
  });
});
