import {
  CodeRenderable,
  RGBA,
  type MarkdownOptions,
  type TreeSitterClient,
  type RenderContext,
  type Renderable,
} from "@opentui/core";
import { baseComponents, extend } from "@opentui/react";
import { highlightCode } from "../parity/code-highlights.boundary.js";
import { PALETTE } from "../parity/tokens.js";

type MarkdownToken = Parameters<NonNullable<MarkdownOptions["renderNode"]>>[0];
type SessionMarkdownOptions = MarkdownOptions & { readonly treeSitterClient: TreeSitterClient };

/** Keep OpenTUI's incremental block identities; decorating a replacement box disables reuse. */
class ReferenceMarkdown extends baseComponents.markdown {
  private readonly tokens: Map<string, MarkdownToken>;

  constructor(context: RenderContext, options: SessionMarkdownOptions) {
    const tokens = new Map<string, MarkdownToken>();
    super(context, {
      ...options,
      fg: PALETTE.text,
      internalBlockMode: "top-level",
      renderNode(token, rendering) {
        const child = rendering.defaultRender();
        if (child !== null) tokens.set(child.id, token);
        return child;
      },
    });
    this.tokens = tokens;
    this.styleBlocks();
  }

  override get content(): string {
    return super.content;
  }
  override set content(value: string) {
    super.content = value;
    this.styleBlocks();
  }
  override get streaming(): boolean {
    return super.streaming;
  }
  override set streaming(value: boolean) {
    super.streaming = value;
    this.styleBlocks();
  }

  private styleBlocks(): void {
    const children = this.getChildren();
    const active = new Set(children.map((child) => child.id));
    for (const id of this.tokens.keys()) if (!active.has(id)) this.tokens.delete(id);
    for (const child of children) {
      const token = this.tokens.get(child.id);
      if (token !== undefined) styleBlock(child, token);
    }
  }
}

function styleBlock(child: Renderable, token: MarkdownToken): void {
  const code = token.type === "code";
  child.paddingTop = token.type === "heading" ? (child.marginTop === 0 ? 2 : 1) : code ? 1 : 0;
  child.paddingBottom = code ? 2 : 1;
  child.paddingLeft = code ? 2 : token.type === "list" ? Number(token.ordered) : 0;
  child.paddingRight = code ? 2 : 0;
  if (token.type === "list" && !token.ordered) useBulletMarkers(child);
  if (code && child instanceof CodeRenderable) {
    child.bg = RGBA.fromHex(PALETTE.codeBackground);
    child.drawUnstyledText = true;
    child.wrapMode = "word";
    child.onChunks = codeChunks;
  }
}

const codeChunks: NonNullable<CodeRenderable["onChunks"]> = (_chunks, context) =>
  highlightCode(context.content, context.filetype).map((part) => ({
    ...part,
    __isChunk: true as const,
    fg: RGBA.fromHex(part.fg),
  }));

function useBulletMarkers(child: Renderable): void {
  for (const row of child.getChildren()) {
    const marker = row.getChildren()[0];
    if (marker instanceof baseComponents.text) {
      marker.content = "• ";
      marker.fg = PALETTE.link;
    }
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    referenceMarkdown: typeof baseComponents.markdown;
  }
}

export function registerReferenceMarkdown(parser: TreeSitterClient): void {
  class SessionMarkdown extends ReferenceMarkdown {
    constructor(context: RenderContext, options: MarkdownOptions) {
      super(context, { ...options, treeSitterClient: parser });
    }
  }
  extend({ referenceMarkdown: SessionMarkdown });
}
