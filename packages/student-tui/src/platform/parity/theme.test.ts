import { describe, expect, it } from "vitest";

import { PALETTE } from "../../parity/tokens.js";
import {
  ASCII_LEFT,
  ATTRIBUTES,
  leftSide,
  SOLID_LEFT,
  TOOL_GLYPHS,
  toolColour,
  WIDE_LEFT,
} from "./theme.js";

describe("single-column borders", () => {
  it.each([
    ["the student's own message", WIDE_LEFT, "▎"],
    ["a tool call", ASCII_LEFT, "|"],
    ["the command suggestions", SOLID_LEFT, "│"],
  ])("draws %s as one column of its own glyph", (_name, characters, glyph) => {
    // Every drawn edge is the glyph itself; the unused right-hand corners and
    // the horizontal run are blank, which is what makes it a single column.
    expect(Object.keys(characters)).toHaveLength(11);
    expect(new Set(Object.values(characters))).toEqual(new Set([glyph, " "]));
    const blank = Object.entries(characters)
      .filter(([, value]) => value === " ")
      .map(([name]) => name)
      .toSorted();
    expect(blank).toEqual(["bottomRight", "horizontal", "topRight"]);
    expect(characters.vertical).toBe(glyph);
  });

  it("puts the box on the left side only", () => {
    expect(leftSide()).toEqual(["left"]);
  });
});

describe("tool marks", () => {
  it("gives each state its own glyph and colour", () => {
    expect(TOOL_GLYPHS).toEqual({ done: "✓", failed: "x", running: "●" });
    expect(toolColour("running")).toBe(PALETTE.accent);
    expect(toolColour("done")).toBe(PALETTE.depth);
    expect(toolColour("failed")).toBe(PALETTE.warning);
  });
});

describe("attributes", () => {
  it("mirrors the library's bits", () => {
    expect(ATTRIBUTES).toEqual({
      bold: 1,
      boldItalic: 5,
      italic: 4,
      none: 0,
      underline: 8,
    });
  });
});
