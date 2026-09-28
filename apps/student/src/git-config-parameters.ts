/** Git's command-scope parser accepts separately quoted keys and values. */
export function appendGitConfigParameters(
  existing: string | undefined,
  entries: readonly (readonly [string, string])[],
): string {
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  const appended = entries.map(([key, value]) => `${quote(key)}=${quote(value)}`).join(" ");
  return [existing, appended].filter((value) => value !== undefined && value !== "").join(" ");
}
