/** MAREA CODE, with the reference's solid front and two-tone block-letter shadow. */

export const WORDMARK: readonly string[] = Object.freeze([
  "███╗   ███╗  █████╗  ██████╗  ███████╗  █████╗     ██████╗  ██████╗ ██████╗ ███████╗",
  "████╗ ████║ ██╔══██╗ ██╔══██╗ ██╔════╝ ██╔══██╗   ██╔════╝ ██╔═══██╗██╔══██╗██╔════╝",
  "██╔████╔██║ ███████║ ██████╔╝ █████╗   ███████║   ██║      ██║   ██║██║  ██║█████╗  ",
  "██║╚██╔╝██║ ██╔══██║ ██╔══██╗ ██╔══╝   ██╔══██║   ██║      ██║   ██║██║  ██║██╔══╝  ",
  "██║ ╚═╝ ██║ ██║  ██║ ██║  ██║ ███████╗ ██║  ██║   ╚██████╗ ╚██████╔╝██████╔╝███████╗",
  "╚═╝     ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝    ╚═════╝  ╚═════╝ ╚═════╝ ╚══════╝",
]);

/** Columns the artwork needs, excluding surrounding padding. */
export const WORDMARK_WIDTH = 84;

type WordmarkTone = "mark" | "depth" | "space";

export interface WordmarkSpan {
  readonly text: string;
  readonly tone: WordmarkTone;
}

const SOLID = "█";

function toneOf(glyph: string): WordmarkTone {
  if (glyph === SOLID) return "mark";
  return glyph === " " ? "space" : "depth";
}

/** Splits one wordmark line into the longest runs that share a tone. */
export function wordmarkLineSpans(line: string): readonly WordmarkSpan[] {
  const spans: WordmarkSpan[] = [];
  for (const glyph of line) {
    const tone = toneOf(glyph);
    const last = spans.at(-1);
    if (last?.tone === tone) spans[spans.length - 1] = { text: last.text + glyph, tone };
    else spans.push({ text: glyph, tone });
  }
  return spans;
}

/** Keep the complete name readable when the block letters cannot fit. */
export function wordmarkLines(columns: number): readonly string[] {
  return columns >= WORDMARK_WIDTH ? WORDMARK : ["MAREA CODE"];
}
