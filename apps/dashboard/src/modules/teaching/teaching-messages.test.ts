import { describe, expect, it } from "vitest";

import { teachingMessages } from "./teaching-messages.js";

describe("teaching messages", () => {
  it("provides complete English and Spanish copies for every state", () => {
    const english = teachingMessages("en");
    const spanish = teachingMessages("es");
    expect(Object.keys(english)).toEqual(Object.keys(spanish));
    expect(Object.keys(english.problems)).toEqual(Object.keys(spanish.problems));
    expect(english.savedVersion("revision:one")).toBe("Saved version revision:one");
    expect(spanish.savedVersion("revision:one")).toBe("Versión guardada revision:one");
    expect(english.switchPrompt("Physics")).toBe(
      "Switch to Physics? Unsaved draft changes will be lost.",
    );
    expect(spanish.switchPrompt("Física")).toBe(
      "¿Cambiar a Física? Los cambios sin guardar se perderán.",
    );
    expect(english).toMatchSnapshot();
    expect(spanish).toMatchSnapshot();
  });
});
