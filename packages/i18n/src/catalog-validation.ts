import { FALLBACK_LOCALE, SUPPORTED_LOCALES, type Locale } from "./locale.js";

export interface CatalogIntegrityIssue {
  readonly locale: Locale;
  readonly kind: "missing-key" | "extra-key" | "parameter-mismatch";
  readonly key: string;
  readonly expected?: readonly string[];
  readonly actual?: readonly string[];
}

export function messagePlaceholders(template: string | undefined): readonly string[] {
  const placeholders = template?.match(/\{\{[A-Za-z][A-Za-z0-9._-]*\}\}/gu) ?? [];
  return Object.freeze(placeholders.map((placeholder) => placeholder.slice(2, -2)).toSorted());
}

export function validateCatalogIntegrity(
  catalogs: Readonly<Record<Locale, Readonly<Partial<Record<string, string>>>>>,
): readonly CatalogIntegrityIssue[] {
  const issues: CatalogIntegrityIssue[] = [];
  const expectedKeys = Object.keys(catalogs[FALLBACK_LOCALE]).toSorted();
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = catalogs[locale];
    const keys = Object.keys(catalog).toSorted();
    for (const key of expectedKeys) {
      if (!Object.hasOwn(catalog, key)) {
        issues.push({ locale, kind: "missing-key", key });
        continue;
      }
      const expected = messagePlaceholders(catalogs[FALLBACK_LOCALE][key]);
      const actual = messagePlaceholders(catalog[key]);
      if (expected.join("\0") !== actual.join("\0")) {
        issues.push({ locale, kind: "parameter-mismatch", key, expected, actual });
      }
    }
    for (const key of keys) {
      if (!Object.hasOwn(catalogs[FALLBACK_LOCALE], key)) {
        issues.push({ locale, kind: "extra-key", key });
      }
    }
  }
  return Object.freeze(issues);
}

export function assertCatalogIntegrity(
  catalogs: Readonly<Record<Locale, Readonly<Partial<Record<string, string>>>>>,
): void {
  const issues = validateCatalogIntegrity(catalogs);
  if (issues.length > 0) {
    throw new Error(`Localization catalog integrity failed for ${String(issues.length)} issue(s).`);
  }
}
