import { describe, expect, it } from "vitest";

import {
  WORDMARK,
  WORDMARK_WIDTH,
  wordmarkLines,
  wordmarkLineSpans,
  type WordmarkSpan,
} from "./wordmark.js";

function toneRun(spans: readonly WordmarkSpan[], tone: WordmarkSpan["tone"]): string {
  return spans
    .filter((span) => span.tone === tone)
    .map((span) => span.text)
    .join("");
}

describe("wordmark", () => {
  it("draws six lines that fit the declared width", () => {
    expect(WORDMARK).toHaveLength(6);
    const widths = WORDMARK.map((line) => Array.from(line).length);
    expect(Math.max(...widths)).toBe(WORDMARK_WIDTH);
    expect(Math.min(...widths)).toBeGreaterThan(WORDMARK_WIDTH - 2);
  });

  it("uses block and shadow glyphs for MAREA CODE", () => {
    const glyphs = new Set(Array.from(WORDMARK.join("")));
    expect([...glyphs].toSorted()).toEqual([" ", "═", "║", "╔", "╗", "╚", "╝", "█"]);
  });

  it("splits a line into solid, shadow and gap runs", () => {
    expect(wordmarkLineSpans("██╗ █")).toEqual([
      { text: "██", tone: "mark" },
      { text: "╗", tone: "depth" },
      { text: " ", tone: "space" },
      { text: "█", tone: "mark" },
    ]);
  });

  it("keeps every glyph of every line when splitting", () => {
    for (const line of WORDMARK) {
      const spans = wordmarkLineSpans(line);
      expect(spans.map((span) => span.text).join("")).toBe(line);
      expect(toneRun(spans, "mark")).toBe(
        Array.from(line)
          .filter((glyph) => glyph === "█")
          .join(""),
      );
    }
  });

  it("returns no spans for an empty line", () => {
    expect(wordmarkLineSpans("")).toEqual([]);
  });

  it("shows the mark from its own width upwards", () => {
    expect(wordmarkLines(WORDMARK_WIDTH)).toBe(WORDMARK);
    expect(wordmarkLines(WORDMARK_WIDTH + 1)).toBe(WORDMARK);
  });

  it("shows the complete name as text when block letters cannot fit", () => {
    expect(wordmarkLines(WORDMARK_WIDTH - 1)).toEqual(["MAREA CODE"]);
  });
});
