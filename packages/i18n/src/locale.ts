export const DEFAULT_LOCALE = "es" as const;
export const FALLBACK_LOCALE = "en" as const;
export const SUPPORTED_LOCALES = Object.freeze([DEFAULT_LOCALE, FALLBACK_LOCALE, "eu"] as const);

export const LOCALE_NAMES = Object.freeze({
  es: "Castellano",
  en: "English",
  eu: "Euskara",
} as const);

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = "automatic" | Locale;
export type LocaleRequest = string | readonly string[] | null | undefined;

const LOCALE_TAG = /^[a-z]{2}(?:-[a-z0-9]{2,8})*$/u;
const SYSTEM_LOCALE_SUFFIX = /(?:[.@][A-Za-z0-9_-]+)+/u;
const SYSTEM_LOCALE_SEPARATOR = /_/gu;
const LOCALE_BY_LANGUAGE: Readonly<Record<string, Locale>> = Object.freeze({
  en: "en",
  es: "es",
  eu: "eu",
});

/** Normalizes a browser or operating-system locale at the platform boundary. */
export function normalizeLocaleTag(value: string): string | null {
  const trimmed = value.trim();
  const normalized = trimmed
    .replace(SYSTEM_LOCALE_SUFFIX, "")
    .replace(SYSTEM_LOCALE_SEPARATOR, "-");
  const lower = normalized.toLowerCase();
  return LOCALE_TAG.test(lower) ? lower : null;
}

export function parseLocale(value: string): Locale | null {
  const normalized = normalizeLocaleTag(value);
  if (normalized === null) return null;
  const language = normalized.slice(0, 2);
  return LOCALE_BY_LANGUAGE[language] ?? null;
}

export function parseLocalePreference(value: string | null | undefined): LocalePreference | null {
  if (typeof value !== "string") return null;
  if (value.trim().toLowerCase() === "automatic") return "automatic";
  return parseLocale(value);
}

export function selectLocale(requested?: LocaleRequest): Locale {
  if (typeof requested === "string") {
    return parseLocale(requested) ?? DEFAULT_LOCALE;
  }

  if (requested === null || requested === undefined) {
    return DEFAULT_LOCALE;
  }

  const candidates = requested;
  for (const candidate of candidates) {
    const locale = parseLocale(candidate);
    if (locale !== null) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

/** Resolves an explicit preference, or detects the first supported system locale. */
export function selectLocaleFromPreference(
  preference: LocalePreference | null | undefined,
  detected?: LocaleRequest,
): Locale {
  if (preference !== undefined && preference !== null && preference !== "automatic") {
    return preference;
  }
  return selectLocale(detected);
}

export interface LocaleResolutionInput {
  readonly commandLine?: string | null | undefined;
  readonly environment?: string | null | undefined;
  readonly saved?: string | null | undefined;
  readonly system?: LocaleRequest;
}

export interface LocaleResolution {
  readonly locale: Locale;
  readonly preference: LocalePreference;
  readonly source: "command-line" | "environment" | "saved" | "system" | "default";
}

/** Applies the student-client precedence without reading any platform state. */
export function resolveLocalePreference(input: LocaleResolutionInput): LocaleResolution {
  const commandLine = parseLocalePreference(input.commandLine);
  if (input.commandLine !== undefined && commandLine === null) {
    throw new Error("The --lang value must be automatic, es, en, or eu.");
  }
  if (commandLine !== null) {
    return resolveExplicit(commandLine, "command-line", input.system);
  }

  const environment = parseLocalePreference(input.environment);
  if (input.environment !== undefined && input.environment !== "" && environment === null) {
    throw new Error("The MAREA_LANG value must be automatic, es, en, or eu.");
  }
  if (environment !== null) return resolveExplicit(environment, "environment", input.system);

  const saved = parseLocalePreference(input.saved);
  if (saved !== null && saved !== "automatic") {
    return { locale: saved, preference: saved, source: "saved" };
  }
  if (saved === "automatic") return resolveDetected(input.system, "saved");
  return resolveDetected(input.system, "system");
}

function resolveExplicit(
  preference: LocalePreference,
  source: "command-line" | "environment",
  system: LocaleRequest,
): LocaleResolution {
  return preference === "automatic"
    ? resolveDetected(system, source)
    : { locale: preference, preference, source };
}

function resolveDetected(
  system: LocaleRequest,
  source: "saved" | "system" | "command-line" | "environment",
): LocaleResolution {
  const locale = selectLocale(system);
  return {
    locale,
    preference: "automatic",
    source:
      source === "saved" || source === "system"
        ? source
        : locale === DEFAULT_LOCALE
          ? "default"
          : source,
  };
}
