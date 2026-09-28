import { PALETTE } from "../../parity/tokens.js";

/**
 * Border shapes the reference draws that OpenTUI has no name for.
 *
 * Textual's `wide` and `ascii` left borders are single columns of one glyph,
 * so they are expressed here as a full character set whose every entry is that
 * glyph and whose box is drawn on the left side only.
 */

export interface BorderCharacters {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly topT: string;
  readonly bottomT: string;
  readonly leftT: string;
  readonly rightT: string;
  readonly cross: string;
}

function column(glyph: string): BorderCharacters {
  return Object.freeze({
    bottomLeft: glyph,
    bottomRight: " ",
    bottomT: glyph,
    cross: glyph,
    horizontal: " ",
    leftT: glyph,
    rightT: glyph,
    topLeft: glyph,
    topRight: " ",
    topT: glyph,
    vertical: glyph,
  });
}

/** The heavy marker beside a student's own message. */
export const WIDE_LEFT = column("▎");

/** The light rule beside a tool call. */
export const ASCII_LEFT = column("|");

/** The rule beside the command suggestions. */
export const SOLID_LEFT = column("│");

/** Draw the box on its left side only. OpenTUI takes a mutable list. */
export function leftSide(): ["left"] {
  return ["left"];
}

/** The colour of a tool's glyph, which is also the colour of its rule. */
export function toolColour(glyph: "running" | "done" | "failed"): string {
  if (glyph === "running") return PALETTE.accent;
  return glyph === "failed" ? PALETTE.warning : PALETTE.depth;
}

/**
 * OpenTUI's text attribute bits, mirrored so that a component tested under
 * Node never has to load the native renderer. `attributes.bun.test.tsx`
 * checks these against the library's own values.
 */
export const ATTRIBUTES = Object.freeze({
  bold: 1,
  boldItalic: 5,
  italic: 4,
  none: 0,
  underline: 8,
} as const);

export const TOOL_GLYPHS: Readonly<Record<"running" | "done" | "failed", string>> = Object.freeze({
  done: "✓",
  failed: "x",
  running: "●",
});
