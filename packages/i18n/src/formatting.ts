import type { Locale } from "./locale.js";

export type PluralCategory = Intl.LDMLPluralRule;

export type PluralMessages = Readonly<Partial<Record<PluralCategory, string>>>;

export function selectPlural(locale: Locale, value: number): PluralCategory {
  return new Intl.PluralRules(locale).select(value);
}

/** Selects a complete, already localized message using the platform plural rules. */
export function formatPlural(locale: Locale, value: number, messages: PluralMessages): string {
  const category = selectPlural(locale, value);
  return messages[category] ?? messages.other ?? messages.one ?? "";
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(
  locale: Locale,
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatDateTime(locale: Locale, value: Date | number | string): string {
  return formatDate(locale, value, { dateStyle: "medium", timeStyle: "short" });
}
