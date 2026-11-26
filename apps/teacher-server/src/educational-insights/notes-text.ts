const two = (value: number) => String(value).padStart(2, "0");

/**
 * The `dd/mm/aaaa` day of an instant in the server's local time zone. The teacher server runs on
 * the school's own computer, so its zone is the classroom's; SQLite's `localtime` agrees with it.
 */
export function noteDate(instant: string): string {
  const date = new Date(instant);
  return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${String(date.getFullYear())}`;
}

/** Appends one dated line; an empty history simply starts with it. */
export function appendNote(notes: string, line: string): string {
  return notes === "" ? line : `${notes}\n${line}`;
}

/**
 * The newest whole lines of `text` whose JSON string form fits in `limit` bytes, and how many
 * characters were left out. A single approved note is always far smaller than the limit.
 */
export function recentLines(text: string, limit: number) {
  const lines = text.split("\n");
  // The surrounding quotes of the JSON string.
  let size = 2;
  let start = lines.length;
  for (const line of lines.toReversed()) {
    // Each kept line after the newest one also carries its escaped newline (two bytes).
    const cost = Buffer.byteLength(JSON.stringify(line)) - (start === lines.length ? 2 : 0);
    if (size + cost > limit) break;
    size += cost;
    start--;
  }
  const kept = lines.slice(start).join("\n");
  return { text: kept, omitted: text.length - kept.length };
}
