import { expect, it } from "vitest";
import { identityFieldError } from "./identity-validation.js";

const rule = {
  maxLength: 3,
  pattern: "^[a-z]+$",
  normalize: "none" as const,
  message: { en: "Invalid", es: "No válido", eu: "Baliogabea" },
};
it("applies optional provider constraints and localized errors", () => {
  expect(identityFieldError(undefined, "ANY", "en")).toBe("");
  expect(identityFieldError(rule, "", "en")).toBe("");
  expect(identityFieldError(rule, "abc", "en")).toBe("");
  expect(identityFieldError(rule, "abcd", "es")).toBe("No válido");
  expect(identityFieldError(rule, "A", "eu")).toBe("Baliogabea");
  expect(identityFieldError({ ...rule, normalize: "lowercase-trim" }, " ABC ", "en")).toBe("");
});
