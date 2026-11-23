import type { ProviderSettingsDescriptor } from "@marea/plugin-api";
import type { DashboardLocale } from "../messages.js";

export function identityFieldError(
  validation: ProviderSettingsDescriptor["fields"][number]["validation"],
  value: string,
  locale: DashboardLocale,
): string {
  if (validation === undefined || value === "") return "";
  const normalized = validation.normalize === "lowercase-trim" ? value.trim().toLowerCase() : value;
  return normalized.length <= validation.maxLength &&
    new RegExp(validation.pattern, "u").test(normalized)
    ? ""
    : validation.message[locale];
}
