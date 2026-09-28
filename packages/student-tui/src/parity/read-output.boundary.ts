const READERS = new Set(["marea_read_project", "marea_read_skill", "marea_list_project"]);

/** Decode only host read envelopes, once. File text that happens to be JSON stays file text. */
export function readableToolResult(name: string, result: string): string {
  if (!READERS.has(name)) return result;
  try {
    // The guarded property reads below reject primitives and incomplete envelopes;
    // null is handled by the same fallback as malformed JSON.
    const page = JSON.parse(result) as Record<string, unknown>;
    if (
      typeof page.content !== "string" ||
      typeof page.offset !== "number" ||
      typeof page.totalLength !== "number" ||
      !(page.nextOffset === null || typeof page.nextOffset === "number")
    )
      return result;
    if (name !== "marea_list_project") return page.content;
    try {
      return JSON.stringify(JSON.parse(page.content), null, 2);
    } catch {
      return page.content;
    }
  } catch {
    return result;
  }
}
