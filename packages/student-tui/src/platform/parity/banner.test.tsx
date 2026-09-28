import { describe, expect, it } from "vitest";

import { PARITY_TEST_COPY } from "../../../test-support/parity-copy.js";
import {
  nodesOfType,
  renderedText,
  textLines,
} from "../../../test-support/element-tree.boundary.js";
import type { SessionContext } from "../../parity/events.js";
import { PALETTE } from "../../parity/tokens.js";
import { WORDMARK_WIDTH } from "../../parity/wordmark.js";
import { Banner, contextLines } from "./banner.js";

const copy = PARITY_TEST_COPY.banner;

const FULL: SessionContext = {
  branch: "main",
  cwd: "/Users/alumna/proyecto",
  model: "modelo-docente",
  repositoryUrl: "https://ejemplo/repo.git",
};

describe("banner context", () => {
  it("lists the fields in the reference order", () => {
    expect(contextLines(FULL, copy).map((line) => line.label)).toEqual([
      copy.model,
      copy.directory,
      copy.branch,
      copy.repository,
    ]);
  });

  it("skips what the session does not know, rather than inventing it", () => {
    const partial: SessionContext = { branch: "", cwd: "/p", model: "", repositoryUrl: "" };
    expect(contextLines(partial, copy)).toEqual([{ label: copy.directory, value: "/p" }]);
  });
});

describe("banner", () => {
  it("draws the wordmark, the context and the footer", () => {
    const lines = textLines(Banner({ columns: 100, context: FULL, copy }));
    expect(lines).toHaveLength(12);
    expect(lines.slice(0, 5).every((line) => line.includes("█"))).toBe(true);
    expect(lines[5]).toContain("╚═╝");
    expect(lines[6]).toBe(`modelo       modelo-docente`);
    expect(lines[7]).toBe(`directorio   /Users/alumna/proyecto`);
    expect(lines[8]).toBe(`rama         main`);
    expect(lines[10]).toBe(" ");
    expect(lines.at(-1)).toBe(copy.footer);
  });

  it("colours the solid blocks accent and the shadow depth, both in bold", () => {
    const spans = nodesOfType(Banner({ columns: 100, context: FULL, copy }), "span");
    const solid = spans.filter((span) => renderedText(span.children).startsWith("█"));
    const shadow = spans.filter((span) => renderedText(span.children).startsWith("╗"));
    expect(solid.length).toBeGreaterThan(0);
    expect(shadow.length).toBeGreaterThan(0);
    expect(new Set(solid.map((span) => span.props.fg))).toEqual(new Set([PALETTE.accent]));
    expect(new Set(shadow.map((span) => span.props.fg))).toEqual(new Set([PALETTE.depth]));
    expect(spans.every((span) => span.props.attributes === 1)).toBe(true);
  });

  it("gives every line and every run its own key", () => {
    const rendered = Banner({ columns: 100, context: FULL, copy });
    const lineKeys = nodesOfType(rendered, "text")
      .map((node) => node.key)
      .filter((key): key is string => key?.startsWith("mark-") === true);
    expect(lineKeys).toEqual(["mark-0", "mark-1", "mark-2", "mark-3", "mark-4", "mark-5"]);
    const runKeys = nodesOfType(rendered, "span").map((node) => node.key);
    expect(new Set(runKeys).size).toBeGreaterThan(1);
    expect(runKeys.every((key) => key?.startsWith("s-"))).toBe(true);
  });

  it("uses the compact name in a narrow terminal", () => {
    const narrow = textLines(Banner({ columns: WORDMARK_WIDTH - 1, context: FULL, copy }));
    expect(narrow[0]).toBe("MAREA CODE");
    expect(narrow.at(-1)).toBe(copy.footer);
  });
});
