/** 8K UTF-16 code units remain below the gateway's 64K limit even after JSON escaping. */
const PAGE_LENGTH = 8_192;

export function readToolPage(text: string, offset: number): string {
  if (offset > text.length) throw new Error("The read offset is past the end of the content.");
  const end = Math.min(offset + PAGE_LENGTH, text.length);
  return JSON.stringify({
    content: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalLength: text.length,
  });
}
