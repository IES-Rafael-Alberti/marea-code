/** @jsxImportSource @opentui/react */
import { act, useState } from "react";
import { expect, it } from "vitest";
import { getTreeSitterClient, SyntaxStyle, type Renderable } from "@opentui/core";
import { registerReferenceMarkdown } from "../src/platform/reference-markdown.boundary.js";

it("retains the growing native paragraph between streamed updates", async () => {
  const { testRender } = await import("@opentui/react/test-utils");
  registerReferenceMarkdown(getTreeSitterClient());
  const style = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } });
  let append!: (text: string) => void;
  function Harness() {
    const [text, setText] = useState("An answer");
    append = setText;
    return <referenceMarkdown content={text} streaming syntaxStyle={style} />;
  }
  const setup = await testRender(<Harness />, { width: 50, height: 20 });
  try {
    await setup.flush();
    const markdown = childAt(setup.renderer.root, 0);
    const paragraph = markdown.getChildren()[0];
    for (const text of [
      "An answer with",
      "An answer with **styled text**",
      "An answer with **styled text** that wraps. ".repeat(5),
    ]) {
      act(() => {
        append(text);
      });
      await setup.flush();
      expect(markdown.getChildren()[0]).toBe(paragraph);
      expect(setup.captureCharFrame()).toContain("An answer");
    }
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    style.destroy();
  }
});

it.each(["paragraph", "list", "code"] as const)(
  "keeps %s geometry and scrolling stable while streaming, finishing and resizing",
  async (kind) => {
    const { testRender } = await import("@opentui/react/test-utils");
    const { registerReferenceBoxes } = await import("../src/platform/reference-box.boundary.js");
    registerReferenceBoxes();
    registerReferenceMarkdown(getTreeSitterClient());
    const style = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } });
    let update!: (value: { text: string; streaming: boolean }) => void;
    const prefix = kind === "code" ? "```python\n" : kind === "list" ? "- " : "";
    function Harness() {
      const [value, setValue] = useState({ text: prefix + "first", streaming: true });
      update = setValue;
      return (
        <box width="100%" height="100%" flexDirection="column">
          <referenceConversation
            stickyScroll
            stickyStart="bottom"
            flexGrow={1}
            contentOptions={{ minHeight: "100%", justifyContent: "flex-end" }}
          >
            <referenceMarkdown
              content={value.text}
              streaming={value.streaming}
              syntaxStyle={style}
            />
          </referenceConversation>
          <text height={1}>COMPOSER</text>
        </box>
      );
    }
    const setup = await testRender(<Harness />, { width: 40, height: 12 });
    try {
      await setup.flush();
      await setup.flush();
      const root = childAt(setup.renderer.root, 0);
      const scroll = root.getChildren()[0] as import("@opentui/core").ScrollBoxRenderable;
      const composer = childAt(root, 1);
      const markdown = childAt(scroll, 0);
      const block = markdown.getChildren()[0];
      const composerY = composer.y;
      let previousTop = scroll.scrollTop;
      let text = prefix + "first";
      for (let index = 0; index < 25; index += 1) {
        text +=
          kind === "code" ? `print("line ${String(index)}")\n` : "More words with **bold** text. ";
        act(() => {
          update({ text, streaming: true });
        });
        await new Promise((resolve) => setTimeout(resolve, 33));
        await setup.flush();
        const height = markdown.height;
        const top = scroll.scrollTop;
        const frame = setup.captureCharFrame();
        await setup.flush();
        expect(markdown.getChildren()[0] === block).toBe(true);
        expect(markdown.height).toBe(height);
        expect(scroll.scrollTop).toBe(top);
        expect(setup.captureCharFrame()).toBe(frame);
        expect(composer.y).toBe(composerY);
        expect(top).toBeGreaterThanOrEqual(previousTop);
        previousTop = top;
      }
      expect(scroll.scrollTop, setup.captureCharFrame()).toBeGreaterThan(0);
      if (kind === "code") expect(setup.captureCharFrame()).toContain('print("line 24")');
      scroll.scrollBy(-4);
      await setup.flush();
      const manualTop = scroll.scrollTop;
      text += kind === "code" ? 'print("last")\n' : "Another sentence. ";
      act(() => {
        update({ text, streaming: true });
      });
      await setup.flush();
      expect(scroll.scrollTop).toBe(manualTop);
      act(() => {
        update({ text: text + (kind === "code" ? "```" : ""), streaming: false });
      });
      await setup.flush();
      expect(markdown.getChildren()[0] === block).toBe(true);
      expect(scroll.scrollTop).toBe(manualTop);
      act(() => {
        setup.resize(30, 10);
      });
      await setup.flush();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("COMPOSER");
      const resized = setup.captureCharFrame();
      await setup.flush();
      expect(setup.captureCharFrame()).toBe(resized);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      style.destroy();
    }
  },
);

function childAt(parent: Renderable, index: number): Renderable {
  const child = parent.getChildren()[index];
  if (child === undefined) throw new Error("Missing native renderable");
  return child;
}
