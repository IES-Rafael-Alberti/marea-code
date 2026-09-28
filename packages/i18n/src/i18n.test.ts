import { describe, expect, it } from "vitest";

import {
  CATALOGS,
  DEFAULT_LOCALE,
  ENGLISH_CATALOG,
  FALLBACK_LOCALE,
  LOCALE_NAMES,
  MESSAGE_KEYS,
  SPANISH_CATALOG,
  SUPPORTED_LOCALES,
  formatDateTime,
  formatDate,
  formatNumber,
  formatPlural,
  parseLocalePreference,
  normalizeLocaleTag,
  resolveLocalePreference,
  selectLocaleFromPreference,
  selectPlural,
  validateCatalogIntegrity,
  assertCatalogIntegrity,
  createTranslator,
  parseLocale,
  selectLocale,
  translate,
  type TranslationCatalogs,
} from "./index.js";

describe("locale selection", () => {
  it.each([
    ["es", "es"],
    ["ES_es", "es"],
    [" ES_es ", "es"],
    ["en-US", "en"],
    ["en-Latn-US", "en"],
    ["en_US.UTF-8", "en"],
    ["eu-ES", "eu"],
  ])("normalizes supported locale %s", (input, expected) => {
    expect(parseLocale(input)).toBe(expected);
  });

  it.each(["", "fr-FR", "en-", "en--US", "en-US!", "english"])(
    "rejects unsupported or malformed locale %s",
    (input) => {
      expect(parseLocale(input)).toBeNull();
    },
  );

  it("selects the first supported preference and defaults to Spanish", () => {
    expect(selectLocale(["fr-FR", "en-GB", "es-ES"])).toBe("en");
    expect(selectLocale(["fr-FR", "es-ES"])).toBe("es");
    expect(selectLocale(["fr-FR"])).toBe(DEFAULT_LOCALE);
    expect(selectLocale([])).toBe(DEFAULT_LOCALE);
    expect(selectLocale("en-US")).toBe("en");
    expect(selectLocale("fr-FR")).toBe(DEFAULT_LOCALE);
    expect(selectLocale(null)).toBe(DEFAULT_LOCALE);
    expect(selectLocale()).toBe(DEFAULT_LOCALE);
    expect(selectLocaleFromPreference("automatic", ["fr-FR", "eu-ES"])).toBe("eu");
    expect(selectLocaleFromPreference("en", ["es-ES"])).toBe("en");
    expect(selectLocaleFromPreference(undefined, ["eu-ES"])).toBe("eu");
    expect(selectLocaleFromPreference(null, [])).toBe("es");
    expect(normalizeLocaleTag(" C ")).toBeNull();
    expect(normalizeLocaleTag("POSIX")).toBeNull();
    expect(parseLocalePreference("automatic")).toBe("automatic");
    expect(parseLocalePreference("EU_es")).toBe("eu");
    expect(parseLocalePreference("fr")).toBeNull();
    expect(
      resolveLocalePreference({
        commandLine: "automatic",
        environment: "en",
        system: ["C", "eu_ES.UTF-8"],
      }),
    ).toMatchObject({ locale: "eu", preference: "automatic" });
    expect(
      resolveLocalePreference({ commandLine: "automatic", system: ["C", "POSIX"] }),
    ).toMatchObject({ locale: "es", preference: "automatic", source: "default" });
    expect(() => resolveLocalePreference({ commandLine: "fr", system: [] })).toThrow("--lang");
    expect(() => resolveLocalePreference({ environment: "fr", system: [] })).toThrow("MAREA_LANG");
    expect(
      resolveLocalePreference({ commandLine: "eu", environment: "en", system: [] }),
    ).toMatchObject({ locale: "eu", preference: "eu", source: "command-line" });
    expect(resolveLocalePreference({ environment: "eu", saved: "es", system: [] })).toMatchObject({
      locale: "eu",
      preference: "eu",
      source: "environment",
    });
    expect(
      resolveLocalePreference({ environment: "", saved: "automatic", system: ["eu-ES"] }),
    ).toMatchObject({ locale: "eu", preference: "automatic", source: "saved" });
    expect(resolveLocalePreference({ system: ["fr-FR"] })).toMatchObject({
      locale: "es",
      preference: "automatic",
      source: "system",
    });
  });
});

describe("translation catalogs", () => {
  it("exposes immutable complete catalogs", () => {
    expect(MESSAGE_KEYS).toHaveLength(143);
    expect(new Set(MESSAGE_KEYS).size).toBe(MESSAGE_KEYS.length);
    expect(Object.keys(SPANISH_CATALOG).toSorted()).toEqual([...MESSAGE_KEYS].toSorted());
    expect(Object.keys(ENGLISH_CATALOG).toSorted()).toEqual([...MESSAGE_KEYS].toSorted());
    expect(SUPPORTED_LOCALES).toEqual(["es", "en", "eu"]);
    expect(Object.isFrozen(MESSAGE_KEYS)).toBe(true);
    expect(Object.isFrozen(ENGLISH_CATALOG)).toBe(true);
    expect(Object.isFrozen(SPANISH_CATALOG)).toBe(true);
    expect(Object.isFrozen(CATALOGS)).toBe(true);
    expect(CATALOGS.en).toBe(ENGLISH_CATALOG);
    expect(CATALOGS.es).toBe(SPANISH_CATALOG);
    expect(Object.isFrozen(CATALOGS.eu)).toBe(true);
    expect(LOCALE_NAMES).toEqual({ es: "Castellano", en: "English", eu: "Euskara" });
    expect(validateCatalogIntegrity(CATALOGS)).toEqual([]);
  });

  it("uses Spanish by default and supports English explicitly", () => {
    expect(translate("bootstrap.ready")).toBe("Marea está lista.");
    expect(translate("bootstrap.ready", FALLBACK_LOCALE)).toBe("Marea is ready.");

    const translator = createTranslator("en");
    expect(translator.locale).toBe("en");
    expect(translator.t("bootstrap.starting-session")).toBe("Starting your session…");
    expect(translator.t("skills.frontmatter.invalid")).toBe(
      "Invalid frontmatter in {{location}}. {{action}}",
    );
    expect(createTranslator("eu").t("bootstrap.ready")).toBe("Marea prest dago.");
    expect(Object.isFrozen(translator)).toBe(true);
  });

  it("falls back per key and keeps unresolved placeholders deterministic", () => {
    const catalogs: TranslationCatalogs = Object.freeze({
      en: ENGLISH_CATALOG,
      es: Object.freeze({ "bootstrap.ready": "Listo {{name}}" }),
      eu: Object.freeze({ "bootstrap.ready": "Prest {{name}}" }),
    });

    const spanish = createTranslator("es", catalogs);
    expect(spanish.t("bootstrap.ready")).toBe("Listo {{name}}");
    expect(
      spanish.t("skills.frontmatter.invalid", { location: "SKILL.md", action: "Fix it" }),
    ).toBe("Invalid frontmatter in SKILL.md. Fix it");
    const incomplete = { location: "SKILL.md", action: "Fix it" };
    Reflect.deleteProperty(incomplete, "action");
    expect(spanish.t("skills.frontmatter.invalid", incomplete)).toBe(
      "Invalid frontmatter in SKILL.md. {{action}}",
    );
  });

  it("reports missing, extra, and incompatible catalog entries", () => {
    const incomplete = {
      en: { "bootstrap.ready": "Ready {{name}}", "catalog.extra": "Extra" },
      es: { "bootstrap.ready": "Listo", "catalog.unexpected": "Unexpected" },
      eu: { "bootstrap.ready": "Prest {{other}}" },
    } satisfies Readonly<Record<"en" | "es" | "eu", Readonly<Partial<Record<string, string>>>>>;
    const issues = validateCatalogIntegrity(incomplete);
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          locale: "es",
          kind: "parameter-mismatch",
          key: "bootstrap.ready",
          expected: ["name"],
          actual: [],
        },
        { locale: "es", kind: "extra-key", key: "catalog.unexpected" },
        { locale: "eu", kind: "missing-key", key: "catalog.extra" },
        {
          locale: "eu",
          kind: "parameter-mismatch",
          key: "bootstrap.ready",
          expected: ["name"],
          actual: ["other"],
        },
      ]),
    );
    expect(() => {
      assertCatalogIntegrity(incomplete);
    }).toThrow("Localization catalog integrity failed");

    const undefinedValue = {
      en: { "bootstrap.ready": "Ready" },
      es: { "bootstrap.ready": "Listo" },
      eu: { "bootstrap.ready": "Prest" },
    } satisfies Readonly<Record<"en" | "es" | "eu", Readonly<Partial<Record<string, string>>>>>;
    Object.defineProperty(undefinedValue.en, "bootstrap.ready", { value: undefined });
    Object.defineProperty(undefinedValue.eu, "bootstrap.ready", { value: undefined });
    expect(validateCatalogIntegrity(undefinedValue)).toEqual([]);
  });
});

describe("Intl formatting", () => {
  it("uses the runtime plural and locale formatters", () => {
    expect(selectPlural("es", 1)).toBe("one");
    expect(selectPlural("eu", 2)).toBe("other");
    expect(formatPlural("en", 1, { one: "1 line", other: "{{count}} lines" })).toBe("1 line");
    expect(formatPlural("en", 2, { one: "1 line", other: "{{count}} lines" })).toBe(
      "{{count}} lines",
    );
    expect(formatPlural("en", 2, { one: "1 line" })).toBe("1 line");
    expect(formatPlural("en", 2, {})).toBe("");
    expect(formatNumber("es", 1234.5)).toContain("1");
    expect(formatDate("en", new Date("2026-09-03T08:00:00.000Z"))).toContain("2026");
    expect(formatDateTime("en", "2026-09-03T08:00:00.000Z")).toContain("2026");
    expect(formatDateTime("eu", "2026-09-03T08:00:00.000Z")).toContain("2026");
  });
});
