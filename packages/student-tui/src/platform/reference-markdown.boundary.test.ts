import type { TreeSitterClient } from "@opentui/core";
import { expect, it, vi } from "vitest";
import { PALETTE } from "../parity/tokens.js";

const native = vi.hoisted(() => {
  class Node {
    id = "block";
    children: Node[] = [];
    content = "";
    fg = "";
    marginTop = 0;
    paddingTop = -1;
    paddingBottom = -1;
    paddingLeft = -1;
    paddingRight = -1;
    getChildren() {
      return this.children;
    }
  }
  class Code extends Node {
    bg = "";
    drawUnstyledText = false;
    wrapMode = "none";
    onChunks?: (chunks: unknown[], context: { content: string; filetype: string }) => unknown;
  }
  const state: { token: Record<string, unknown>; block: Node | null; renderNext: boolean } = {
    token: { type: "paragraph" },
    block: null,
    renderNext: true,
  };
  class Markdown {
    children: Node[] = [];
    private text = "";
    private active = true;
    constructor(
      readonly context: unknown,
      readonly options: Record<string, unknown>,
    ) {
      this.text = String(options.content);
      this.refresh();
    }
    getChildren() {
      return this.children;
    }
    get content() {
      return this.text;
    }
    set content(value: string) {
      this.text = value;
      this.refresh();
    }
    get streaming() {
      return this.active;
    }
    set streaming(value: boolean) {
      this.active = value;
      this.refresh();
    }
    private refresh() {
      if (!state.renderNext) return;
      const render = this.options.renderNode as (token: object, context: object) => Node | null;
      const child = render(state.token, { defaultRender: () => state.block });
      this.children = child === null ? [] : [child];
    }
  }
  return { Node, Code, Markdown, state, extend: vi.fn() };
});
vi.mock("@opentui/core", () => ({
  CodeRenderable: native.Code,
  RGBA: { fromHex: (hex: string) => hex },
}));
vi.mock("@opentui/react", () => ({
  baseComponents: { markdown: native.Markdown, text: native.Node },
  extend: native.extend,
}));
import { registerReferenceMarkdown } from "./reference-markdown.boundary.js";

function create(token: Record<string, unknown>, child: InstanceType<typeof native.Node> | null) {
  native.state.token = token;
  native.state.block = child;
  native.state.renderNext = true;
  const parser = {} as TreeSitterClient;
  registerReferenceMarkdown(parser);
  const registration = native.extend.mock.lastCall?.[0] as {
    referenceMarkdown: typeof native.Markdown;
  };
  const markdown = new registration.referenceMarkdown({}, { content: "Initial", fg: "red" });
  expect(markdown.options).toMatchObject({
    fg: PALETTE.text,
    internalBlockMode: "top-level",
    treeSitterClient: parser,
  });
  return markdown;
}

it.each([
  ["paragraph", false, 0, 0],
  ["heading", false, 2, 0],
  ["list", true, 0, 1],
  ["list", false, 0, 0],
  ["blockquote", false, 0, 0],
] as const)("decorates the original %s node without wrapping it", (type, ordered, top, left) => {
  const child = new native.Node();
  const markdown = create({ type, ...(type === "list" ? { ordered } : {}) }, child);
  expect(markdown.getChildren()[0]).toBe(child);
  expect(child).toMatchObject({
    paddingTop: top,
    paddingBottom: 1,
    paddingLeft: left,
    paddingRight: 0,
  });
  markdown.content = "Longer text";
  expect(markdown.content).toBe("Longer text");
  markdown.streaming = false;
  expect(markdown.streaming).toBe(false);
  expect(markdown.getChildren()[0]).toBe(child);
});

it("preserves heading spacing after the native inter-block margin", () => {
  const child = new native.Node();
  child.marginTop = 1;
  create({ type: "heading" }, child);
  expect(child.paddingTop).toBe(1);
});

it("keeps code styling and the highlighting callback stable across updates", () => {
  const child = new native.Code();
  const markdown = create({ type: "code" }, child);
  expect(child).toMatchObject({
    paddingTop: 1,
    paddingBottom: 2,
    paddingLeft: 2,
    paddingRight: 2,
    bg: PALETTE.codeBackground,
    drawUnstyledText: true,
    wrapMode: "word",
  });
  const callback = child.onChunks;
  const chunks = callback?.([], { content: "return 2", filetype: "python" });
  expect(chunks).toEqual([
    { text: "return", fg: "#ffc473", attributes: 0, __isChunk: true },
    { text: " ", fg: "#ffffff", attributes: 0, __isChunk: true },
    { text: "2", fg: "#ffc473", attributes: 0, __isChunk: true },
  ]);
  markdown.content = "return 20";
  expect(child.onChunks).toBe(callback);
  expect(markdown.getChildren()[0]).toBe(child);
  const other = new native.Node();
  create({ type: "code" }, other);
  expect(other).not.toHaveProperty("onChunks");
});

it("restores bullet markers after native list updates and tolerates missing markers", () => {
  const marker = new native.Node();
  marker.content = "- ";
  const row = new native.Node();
  row.children = [marker];
  const list = new native.Node();
  list.children = [row, new native.Node()];
  const markdown = create({ type: "list", ordered: false }, list);
  expect(marker).toMatchObject({ content: "• ", fg: PALETTE.link });
  marker.content = "- ";
  markdown.content = "- More text";
  expect(marker.content).toBe("• ");
});

it("removes obsolete token metadata and ignores nodes without a token", () => {
  const child = new native.Node();
  const markdown = create({ type: "paragraph" }, child);
  native.state.block = null;
  markdown.content = "";
  expect(markdown.getChildren()).toEqual([]);
  const unknown = new native.Node();
  markdown.children = [unknown];
  native.state.renderNext = false;
  markdown.content = "Unknown";
  expect(unknown.paddingBottom).toBe(-1);
  expect(create({ type: "space" }, null).getChildren()).toEqual([]);
});

it.each(["list", "blockquote"])(
  "preserves the %s marker instead of turning it into a bullet",
  (type) => {
    const marker = new native.Node();
    marker.content = "1. ";
    const row = new native.Node();
    row.children = [marker];
    const block = new native.Node();
    block.children = [row];
    create({ type, ...(type === "list" ? { ordered: true } : {}) }, block);
    expect(marker.content).toBe("1. ");
    expect(marker.fg).toBe("");
  },
);

it("reapplies presentation after native finalization replaces a block", () => {
  const markdown = create({ type: "code" }, new native.Code());
  const final = new native.Code();
  native.state.block = final;
  markdown.streaming = false;
  expect(final.bg).toBe(PALETTE.codeBackground);
  expect(final.paddingBottom).toBe(2);
});
