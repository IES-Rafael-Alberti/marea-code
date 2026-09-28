import { expect, it } from "vitest";

import {
  assertCatalogIntegrity,
  messagePlaceholders,
  validateCatalogIntegrity,
} from "./catalog-validation.js";

it("extracts sorted parameter names with their multiplicity and preserves valid punctuation", () => {
  const names = messagePlaceholders(
    "{{z}} {{a.name}} {{b_2}} {{C-1}} {{z}} {{0bad}} {{a!}} {single}",
  );
  expect(names).toEqual(["C-1", "a.name", "b_2", "z", "z"]);
  expect(Object.isFrozen(names)).toBe(true);
  expect(messagePlaceholders("No parameters")).toEqual([]);
  expect(messagePlaceholders(undefined)).toEqual([]);
});

it("accepts complete catalogs with reordered parameters and rejects missing or extra keys", () => {
  const valid = {
    en: { welcome: "Hello {{name}} in {{place}}" },
    es: { welcome: "{{place}}: hola {{name}}" },
    eu: { welcome: "{{name}} / {{place}}" },
  };
  expect(validateCatalogIntegrity(valid)).toEqual([]);
  expect(() => {
    assertCatalogIntegrity(valid);
  }).not.toThrow();
  const invalid = { ...valid, es: {}, eu: { welcome: "{{name}}", unexpected: "Extra" } };
  const issues = validateCatalogIntegrity(invalid);
  expect(issues).toEqual([
    { locale: "es", kind: "missing-key", key: "welcome" },
    {
      locale: "eu",
      kind: "parameter-mismatch",
      key: "welcome",
      expected: ["name", "place"],
      actual: ["name"],
    },
    { locale: "eu", kind: "extra-key", key: "unexpected" },
  ]);
  expect(Object.isFrozen(issues)).toBe(true);
  expect(() => {
    assertCatalogIntegrity(invalid);
  }).toThrow("Localization catalog integrity failed for 3 issue(s).");
});
