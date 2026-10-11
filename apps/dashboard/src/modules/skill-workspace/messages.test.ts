import { expect, it } from "vitest";
import { skillWorkspaceMessages } from "./messages.js";
it("selects localized labels and describes the assignment impact", () => {
  for (const [locale, title, impact] of [
    ["es", "Esta clase", "Se actualizará en 2 clases y 3 selecciones individuales."],
    ["en", "This class", "Will update 2 classes and 3 individual selections."],
    ["eu", "Ikasgela hau", "2 ikasgelatan eta 3 banakako hautaketatan eguneratuko da."],
  ] as const) {
    const m = skillWorkspaceMessages(locale);
    expect(m.classroom).toBe(title);
    expect(m.impact(2, 3)).toBe(impact);
  }
});
