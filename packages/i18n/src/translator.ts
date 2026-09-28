import { DEFAULT_LOCALE, FALLBACK_LOCALE } from "./locale.js";
import type { Locale } from "./locale.js";
import type { MessageKey, MessageParameters } from "./keys.js";
import { CATALOGS } from "./catalogs.js";
import type { TranslationCatalogs } from "./catalogs.js";

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9._-]*)\}\}/gu;

export interface Translator {
  readonly locale: Locale;
  readonly t: <K extends MessageKey>(key: K, parameters?: MessageParameters<K>) => string;
}

export function createTranslator(
  locale: Locale,
  catalogs: TranslationCatalogs = CATALOGS,
): Translator {
  const translateMessage = <K extends MessageKey>(
    key: K,
    parameters?: MessageParameters<K>,
  ): string => interpolate(resolveTemplate(key, locale, catalogs), parameters);

  return Object.freeze({
    locale,
    t: translateMessage,
  });
}

export function translate(
  key: MessageKey,
  locale: Locale = DEFAULT_LOCALE,
  parameters?: MessageParameters,
): string {
  return createTranslator(locale).t(key, parameters);
}

function resolveTemplate(key: MessageKey, locale: Locale, catalogs: TranslationCatalogs): string {
  const localized = catalogs[locale][key];
  if (localized !== undefined) {
    return localized;
  }

  return catalogs[FALLBACK_LOCALE][key];
}

function interpolate(
  template: string,
  parameters: Readonly<Record<string, string | number>> | undefined,
): string {
  if (parameters === undefined) {
    return template;
  }

  return template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = parameters[name];
    return typeof value === "string" || typeof value === "number" ? String(value) : placeholder;
  });
}
