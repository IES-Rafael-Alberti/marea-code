import { expect, it } from "vitest";

import { normalizeLocaleTag, parseLocalePreference, resolveLocalePreference } from "./locale.js";

it("normalizes combined system suffixes but rejects trailing garbage", () => {
  expect(normalizeLocaleTag("eu_ES.UTF-8@modern")).toBe("eu-es");
  expect(normalizeLocaleTag("en_US.UTF-8!")).toBeNull();
  expect(parseLocalePreference("  AUTOMATIC \t")).toBe("automatic");
});

it("keeps saved choices and identifies the source of automatic detection", () => {
  expect(resolveLocalePreference({ saved: "en", system: ["eu"] })).toEqual({
    locale: "en",
    preference: "en",
    source: "saved",
  });
  expect(resolveLocalePreference({ saved: "automatic", system: [] })).toEqual({
    locale: "es",
    preference: "automatic",
    source: "saved",
  });
  expect(
    resolveLocalePreference({ commandLine: "automatic", saved: "es", system: ["eu"] }),
  ).toEqual({ locale: "eu", preference: "automatic", source: "command-line" });
});
