/** @jsxImportSource @opentui/react */
import { act, useEffect, useState } from "react";
import { expect, it, vi } from "vitest";
import { testRender } from "@opentui/react/test-utils";
import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core";

const native = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@opentui/core", async (original) => ({
  ...(await original<typeof import("@opentui/core")>()),
  createCliRenderer: native.create,
}));
// Bun's compiled asset import is exercised by the compiled smoke acceptance.
vi.mock("../src/platform/parser-asset.boundary.js", () => ({ requireParserAsset: vi.fn() }));
import { createNativeOpenTuiHost } from "../src/platform/native-host.boundary.js";
import { createConversationView } from "../src/platform/conversation-view.js";
import { PARITY_TEST_COPY as copy } from "../test-support/parity-copy.js";

it("updates one mounted tree, retaining local state and releasing it on disposal", async () => {
  const setup = await testRender(null, { width: 80, height: 28 });
  native.create.mockResolvedValue(setup.renderer);
  let mounts = 0;
  let unmounts = 0;
  let edit!: (value: string) => void;
  function Screen({ answer }: { readonly answer: string }) {
    const [draft, setDraft] = useState("");
    edit = setDraft;
    useEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);
    return <text>{answer + ":" + draft}</text>;
  }
  const host = await createNativeOpenTuiHost();
  try {
    await act(async () => {
      host.render(<Screen answer="first" />);
      await setup.flush();
    });
    const first = setup.renderer.root.getChildren()[0];
    await act(async () => {
      edit("unfinished draft");
      await setup.flush();
    });
    for (const answer of ["second", "third", "final"]) {
      await act(async () => {
        host.render(<Screen answer={answer} />);
        await setup.flush();
      });
      expect(setup.renderer.root.getChildren()[0]).toBe(first);
      expect(setup.captureCharFrame()).toContain(answer + ":unfinished draft");
      expect(mounts).toBe(1);
      expect(unmounts).toBe(0);
    }
  } finally {
    act(() => {
      host.dispose();
    });
  }
  expect(unmounts).toBe(1);
  host.render(<Screen answer="late" />);
  host.dispose();
  expect(mounts).toBe(1);
  expect(unmounts).toBe(1);
});

it("retains the production conversation, editor and subscriptions across streamed host updates", async () => {
  const setup = await testRender(null, { width: 80, height: 28 });
  native.create.mockResolvedValue(setup.renderer);
  const view = await createConversationView(
    {
      parity: {
        copy,
        context: { cwd: "/synthetic", branch: "main", model: "synthetic", repositoryUrl: "" },
      },
    },
    vi.fn(),
  );
  const student = { author: "student" as const, text: "A synthetic question" };
  const frames: string[] = [];
  const record = () => frames.push(setup.captureCharFrame());
  try {
    await act(async () => {
      view.render({ approval: null, messages: [student], status: "ready" });
      await setup.flush();
    });
    await act(async () => {
      await setup.mockInput.typeText("keep my draft");
      await setup.flush();
    });
    await act(async () => {
      view.render({ approval: null, messages: [student], status: "streaming" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toContain(copy.status.thinking);
    const root = setup.renderer.root.getChildren()[0];
    const editor = setup.renderer.currentFocusedEditor;
    const before = subscriptions(setup.renderer);
    let scroll: Renderable | undefined;
    function find(node: Renderable) {
      if ("scrollTop" in node) scroll = node;
      for (const child of node.getChildren()) find(child);
    }
    find(setup.renderer.root);
    expect(scroll).toBeDefined();
    setup.renderer.on("frame", record);
    let text = "## Streaming\n\n";
    const stream = async () => {
      await act(async () => {
        view.render({
          approval: null,
          messages: [student, { author: "marea", text }],
          status: "streaming",
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    };
    for (let index = 0; index < 35; index += 1) {
      text += "A growing **answer** with words that wrap. ";
      await stream();
      expect(setup.renderer.root.getChildren()[0]).toBe(root);
      expect(setup.renderer.currentFocusedEditor).toBe(editor);
      expect(editor?.plainText).toBe("keep my draft");
      expect(subscriptions(setup.renderer)).toEqual(before);
      const previous = scroll;
      find(setup.renderer.root);
      expect(scroll).toBe(previous);
    }
    expect(setup.captureCharFrame()).toContain(copy.status.responding);
    await act(async () => {
      view.render({
        approval: null,
        messages: [student, { author: "marea", text }],
        status: "streaming",
        activity: "thinking",
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toContain(copy.status.thinking);
    const conversation = scroll as ScrollBoxRenderable;
    await setup.flush();
    expect(conversation.scrollTop).toBeGreaterThan(0);
    conversation.scrollBy(-5);
    await setup.flush();
    const manualTop = conversation.scrollTop;
    text += "More text while reading earlier lines. ".repeat(6);
    await stream();
    await setup.flush();
    expect(conversation.scrollTop).toBe(manualTop);
    await act(async () => {
      view.render({
        approval: null,
        messages: [student, { author: "marea", text }],
        status: "ready",
      });
      await setup.flush();
    });
    expect(frames.length).toBeGreaterThan(35);
    expect(frames.every((frame) => frame.includes("keep my draft"))).toBe(true);
    expect(conversation.scrollTop).toBe(manualTop);
    await act(async () => {
      setup.resize(65, 24);
      await setup.flush();
    });
    expect(setup.renderer.currentFocusedEditor).toBe(editor);
    expect(editor?.plainText).toBe("keep my draft");
  } finally {
    setup.renderer.off("frame", record);
    act(() => {
      view.dispose();
    });
  }
});

function subscriptions(renderer: CliRenderer) {
  return ["resize", "selection", "marea:copied", "marea:quit-hint"].map((event) =>
    renderer.listenerCount(event),
  );
}
