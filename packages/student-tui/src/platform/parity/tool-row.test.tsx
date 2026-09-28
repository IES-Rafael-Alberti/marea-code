import { describe, expect, it } from "vitest";

import {
  nodesOfType,
  renderedText,
  textLines,
} from "../../../test-support/element-tree.boundary.js";
import { PARITY_TEST_COPY } from "../../../test-support/parity-copy.js";
import { GEOMETRY, PALETTE } from "../../parity/tokens.js";
import type { ToolRow } from "../../parity/tool.js";
import { ToolRowView } from "./tool-row.js";

const copy = PARITY_TEST_COPY.tool;

function row(overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    call: { arguments: { command: "pytest -q" }, callId: "c1", name: "execute" },
    expanded: false,
    outcome: null,
    ...overrides,
  };
}

function view(overrides: Partial<ToolRow> = {}, focused = false) {
  return ToolRowView({ copy, focused, row: row(overrides) });
}

describe("running tool", () => {
  it("shows the accent glyph, the label and the argument, and no output", () => {
    const rendered = view();
    expect(renderedText(rendered)).toBe("● shell  pytest -q");
    expect(nodesOfType(rendered, "span")[0]?.props.fg).toBe(PALETTE.accent);
    expect(nodesOfType(rendered, "referenceScrollbox")).toHaveLength(0);
  });

  it("shows only the label when there is nothing to summarise", () => {
    const rendered = ToolRowView({
      copy,
      focused: false,
      row: row({ call: { arguments: {}, callId: "c1", name: "task" } }),
    });
    expect(renderedText(rendered)).toBe("● subagente");
  });
});

describe("finished tool", () => {
  const done = { failed: false, result: "8 passed in 0.42s" };

  it("says nothing extra when the whole output already fits", () => {
    expect(textLines(view({ outcome: { failed: false, result: "a\nb" } }))).toEqual([
      "✓ shell  pytest -q    > output",
      "a",
      "b",
    ]);
  });

  it("marks itself done and openable, in the depth colour", () => {
    const rendered = view({ outcome: done });
    expect(renderedText(rendered)).toContain("✓ shell  pytest -q    > output");
    expect(nodesOfType(rendered, "span")[0]?.props.fg).toBe(PALETTE.depth);
  });

  it("shows the compact summary, bounded to seven rows", () => {
    const rendered = view({ outcome: { failed: false, result: "1\n2\n3\n4\n5" } });
    expect(textLines(rendered).slice(1)).toEqual([
      "… 2 líneas anteriores",
      "3",
      "4",
      "5",
      copy.seeOutput,
    ]);
    expect(
      nodesOfType(rendered, "text")
        .map((node) => node.key)
        .filter((key): key is string => key !== null),
    ).toEqual(["l-0", "l-1", "l-2"]);
    const summary = nodesOfType(rendered, "box").find((node) => node.props.maxHeight !== undefined);
    expect(summary?.props.maxHeight).toBe(GEOMETRY.summaryMaxRows);
    expect(summary?.props.backgroundColor).toBe("#1e1e1e");
    expect(summary?.props.marginRight).toBe(1);
  });

  it("marks itself closable and shows the output when open", () => {
    const rendered = view({ expanded: true, outcome: done });
    expect(renderedText(rendered)).toContain("v output");
    const [output] = nodesOfType(rendered, "referenceScrollbox");
    expect(output?.props.contentBottomInset).toBe(3);
    expect(renderedText(output?.children ?? null)).toBe("8 passed in 0.42s");
  });

  it("shows no output box while the tool is still running, however it is marked", () => {
    expect(nodesOfType(view({ expanded: true }), "referenceScrollbox")).toHaveLength(0);
  });

  it("names an empty output rather than showing a blank box", () => {
    const rendered = view({ expanded: true, outcome: { failed: false, result: "  " } });
    expect(renderedText(nodesOfType(rendered, "referenceScrollbox")[0]?.children ?? null)).toBe(
      copy.emptyOutput,
    );
  });
});

describe("failed tool", () => {
  it("takes the warning colour on its glyph and its rule", () => {
    const rendered = view({ expanded: true, outcome: { failed: true, result: "boom" } });
    expect(renderedText(rendered)).toContain("x shell");
    expect(nodesOfType(rendered, "span")[0]?.props.fg).toBe(PALETTE.warning);
    expect(nodesOfType(rendered, "box")[0]?.props.borderColor).toBe(PALETTE.warning);
  });

  it("keeps the panel rule quiet when nothing failed", () => {
    expect(nodesOfType(view(), "box")[0]?.props.borderColor).toBe(PALETTE.panel);
  });
});

describe("focus", () => {
  it("lifts the row onto the panel colour while it has focus", () => {
    expect(nodesOfType(view({}, true), "box")[0]?.props.backgroundColor).toBe(PALETTE.surface);
    expect(nodesOfType(view(), "box")[0]?.props.backgroundColor).toBe(PALETTE.background);
  });
});

it.each([
  [null, "#b0245e", "#7a1e44"],
  [{ failed: false, result: "ok" }, "#6e8c8a", "#4e6261"],
  [{ failed: true, result: "error" }, "#c9a25e", "#8a7144"],
] as const)("tints the whole tool header with its outcome", (outcome, main, dim) => {
  const tree = view({ outcome });
  expect(nodesOfType(tree, "text")[0]?.props.fg).toBe(main);
  expect(nodesOfType(tree, "span")[2]?.props.fg).toBe(dim);
});

it("renders expanded skill pages as readable text and summarizes collapsed content", () => {
  const output = "first\nsecond\nthird\nfourth\nfifth";
  const base = {
    call: { name: "marea_read_skill", arguments: { path: "SKILL.md" }, callId: "read:1" },
    outcome: {
      failed: false,
      result: JSON.stringify({
        content: output,
        offset: 0,
        nextOffset: null,
        totalLength: output.length,
      }),
    },
  };
  expect(renderedText(view({ ...base, expanded: true }))).toContain(output);
  expect(renderedText(view({ ...base, expanded: false }))).not.toContain('"content"');
});
