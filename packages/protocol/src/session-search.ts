/** Case- and accent-insensitive text, so "alvaro" and "nino" find "Álvaro" and "Niño". */
export function foldSessionText(value: string): string {
  // Stryker disable next-line MethodExpression: both sides fold alike, so upper case matches the same.
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Whether a session list search finds a session. The student and project names are searched
 * one by one, so a search never matches across the boundary between the two. The server and the
 * dashboard share this rule so the instant local filter and the complete server answer agree.
 */
export function sessionSearchMatches(
  search: string,
  studentName: string,
  projectName: string,
): boolean {
  const needle = foldSessionText(search.trim());
  return [studentName, projectName].some((name) => foldSessionText(name).includes(needle));
}
