/** @jsxImportSource @opentui/react */
import { act } from "react";
import { expect, it } from "vitest";
import type { ScrollBoxRenderable } from "@opentui/core";
import { registerReferenceBoxes } from "../src/platform/reference-box.boundary.js";
registerReferenceBoxes();
it.each([
  { content: "short", inset: 3, rows: 5 },
  { content: "word ".repeat(400) + "END", inset: 3, rows: 18 },
  { content: "short", inset: 0, rows: 1 },
  { content: "word ".repeat(400) + "END", inset: 0, rows: 18 },
])(
  "sizes wrapped output to $rows rows with inset $inset and permits scrolling",
  async ({ content, inset, rows }) => {
    const { testRender } = await import("@opentui/react/test-utils");
    const setup = await testRender(
      <box flexDirection="column" width="100%">
        <referenceScrollbox
          contentBottomInset={inset}
          flexGrow={0}
          border={inset === 3}
          padding={inset === 3 ? 1 : 0}
        >
          <text flexShrink={0}>{content}</text>
        </referenceScrollbox>
      </box>,
      { width: 80, height: 40 },
    );
    try {
      await setup.flush();
      await setup.flush();
      const panel = setup.renderer.root.getChildren()[0]?.getChildren()[0] as ScrollBoxRenderable;
      expect(panel.height).toBe(rows);
      if (content !== "short") {
        panel.scrollTo(panel.scrollHeight);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("END");
        await act(async () => {
          setup.resize(40, 30);
          await setup.flush();
        });
        expect(panel.height).toBe(18);
        panel.scrollTo(panel.scrollHeight);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("END");
      }
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  },
);
