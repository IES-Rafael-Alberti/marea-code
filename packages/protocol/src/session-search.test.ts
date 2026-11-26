import { expect, it } from "vitest";
import { foldSessionText, sessionSearchMatches } from "./session-search.js";

it("folds case, accents and the tilde of n", () => {
  expect(foldSessionText("ÁLVARO Niño Ünal")).toBe("alvaro nino unal");
  expect(foldSessionText("plain")).toBe("plain");
});
it("finds a session by student or project name ignoring case and accents", () => {
  expect(sessionSearchMatches("alvaro", "Álvaro Ruiz", "Tienda")).toBe(true);
  expect(sessionSearchMatches("NINO", "Ana", "El niño")).toBe(true);
  expect(sessionSearchMatches("tien", "Ana", "Tienda")).toBe(true);
  expect(sessionSearchMatches("zeta", "Ana", "Tienda")).toBe(false);
});
it("trims the search and matches every session for an empty one", () => {
  expect(sessionSearchMatches("  ana  ", "Ana", "Tienda")).toBe(true);
  expect(sessionSearchMatches("", "Ana", "Tienda")).toBe(true);
});
it("never matches across the student and the project name", () => {
  expect(sessionSearchMatches("ana tienda", "Ana", "Tienda")).toBe(false);
  expect(sessionSearchMatches("a t", "Ana", "Tienda")).toBe(false);
  expect(sessionSearchMatches("anatienda", "Ana", "Tienda")).toBe(false);
});
