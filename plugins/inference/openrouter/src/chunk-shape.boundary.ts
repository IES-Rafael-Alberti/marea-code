const MAX_SHAPE_LENGTH = 256;
const MAX_KEY_LENGTH = 32;
const MAX_DEPTH = 4;

/**
 * The structure of a stream chunk Marea could not read: keys and value types, never values.
 * It reaches the turn diagnostic, so the teacher can tell which provider shape broke a turn
 * without the chunk's text (which may hold the student's or the model's words).
 */
export function chunkShape(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return `not JSON, ${String(text.length)} characters`;
  }
  const shape = describe(value, 0);
  return shape.length > MAX_SHAPE_LENGTH ? `${shape.slice(0, MAX_SHAPE_LENGTH - 1)}…` : shape;
}

function describe(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (depth === MAX_DEPTH) return "…";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${describe(value[0], depth + 1)}]`;
  }
  const entries = Object.entries(value).map(
    ([key, entry]) => `${safeKey(key)}:${describe(entry, depth + 1)}`,
  );
  return `{${entries.join(",")}}`;
}

function safeKey(key: string): string {
  return key.replaceAll(/[^A-Za-z0-9_]/gu, "?").slice(0, MAX_KEY_LENGTH);
}

/** A provider error code reduced to characters that cannot carry text. */
export function safeCode(code: unknown): string {
  const text = typeof code === "string" || typeof code === "number" ? String(code) : "";
  const safe = text.replaceAll(/[^A-Za-z0-9_.-]/gu, "").slice(0, MAX_KEY_LENGTH);
  return safe.length === 0 ? "unknown" : safe;
}
