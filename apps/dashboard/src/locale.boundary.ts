import { parseLocalePreference, type LocalePreference } from "@marea/i18n";

export const DASHBOARD_LOCALE_STORAGE_KEY = "marea.dashboard.interface-language.v1";

export interface DashboardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readDashboardPreference(
  storage: DashboardStorage | undefined,
): LocalePreference | null {
  try {
    // Stryker disable next-line OptionalChaining: absent storage would throw into the same null fallback.
    return parseLocalePreference(storage?.getItem(DASHBOARD_LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeDashboardPreference(
  storage: DashboardStorage | undefined,
  preference: LocalePreference,
): boolean {
  try {
    // Stryker disable next-line OptionalChaining: absent storage would throw into the same false fallback.
    storage?.setItem(DASHBOARD_LOCALE_STORAGE_KEY, preference);
    return storage !== undefined;
  } catch {
    return false;
  }
}
