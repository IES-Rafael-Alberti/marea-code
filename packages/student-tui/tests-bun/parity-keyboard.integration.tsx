import { getTreeSitterClient } from "@opentui/core";
import { registerReferenceMarkdown } from "../src/platform/reference-markdown.boundary.js";
import { registerReferenceBoxes } from "../src/platform/reference-box.boundary.js";
registerReferenceBoxes();
registerReferenceMarkdown(getTreeSitterClient());
/** @jsxImportSource @opentui/react */
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { LiveParityScreen } from "../src/platform/parity/live-screen.js";
import { createPresentation } from "../src/parity/presentation.js";
import { PARITY_TEST_COPY } from "../test-support/parity-copy.js";

it("uses the native editor, keyboard history and focus to answer and reject", async () => {
  const { testRender } = await import("@opentui/react/test-utils");
  const dispatch = vi.fn();
  const presentation = createPresentation(
    { cwd: "/synthetic", branch: "", repositoryUrl: "", model: "" },
    PARITY_TEST_COPY,
    dispatch,
    { entries: ["previous message"], remember: vi.fn() },
  );
  presentation.sync({ approval: null, messages: [], status: "ready" });
  let refresh: () => void = () => {
    throw new Error("Screen not mounted");
  };
  function Screen() {
    const [, update] = useState(0);
    refresh = () => {
      update((version) => version + 1);
    };
    return (
      <LiveParityScreen copy={PARITY_TEST_COPY} presentation={presentation} onAction={dispatch} />
    );
  }
  const setup = await testRender(<Screen />, {
    width: 80,
    height: 24,
    exitOnCtrlC: false,
    kittyKeyboard: true,
  });
  const press = async (key: string, ctrl = false) => {
    await act(async () => {
      setup.mockInput.pressKey(
        ({ up: "\x1b[A", return: "\r", tab: "\t" } as Record<string, string>)[key] ?? key,
        { ctrl },
      );
      await setup.flush();
    });
  };
  try {
    await setup.flush();
    await press("up");
    expect(setup.captureCharFrame()).toContain("previous message");
    await press("return");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "submit", text: "previous message" });
    presentation.sync({
      approval: {
        approvalId: "real-review",
        toolName: "write_file",
        path: "notes.txt",
        content: "full content",
        summary: "Write notes",
        warnings: [],
      },
      messages: [],
      status: "approval",
    });
    await act(async () => {
      refresh();
      await setup.flush();
    });
    await press("n");
    await act(async () => {
      await setup.mockInput.typeText("not yet");
      await setup.flush();
    });
    await press("return");
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "reject",
      interruptId: "real-review",
      reason: "not yet",
    });
    presentation.sync({
      approval: null,
      messages: [],
      status: "questions",
      questions: {
        interruptId: "q1",
        questions: [{ text: "Choose", choices: ["One", "Two"], required: true }],
      },
    });
    await act(async () => {
      refresh();
      await setup.flush();
    });
    await act(async () => {
      await setup.mockInput.typeText("2");
      await setup.flush();
    });
    await press("return");
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "answers",
      interruptId: "q1",
      values: ["Two"],
    });
    presentation.sync({ approval: null, messages: [], status: "ready" });
    await act(async () => {
      refresh();
      await setup.flush();
    });
    const type = async (text: string) => {
      await act(async () => {
        await setup.mockInput.typeText(text);
        await setup.flush();
      });
    };
    await type("first");
    await press("\x1b[13;2u");
    await type("second");
    await press("\x1b[H");
    await press("\x1b[H");
    await type("X");
    await press("return");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "submit", text: "first\nXsecond" });
    await press("up");
    await press("\x1b[H");
    await press("up");
    await press("\x1b[F");
    await press("\x1b[F");
    await press("k", true);
    await press("return");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "submit", text: "firstXsecond" });
    await type("replace this line");
    await press("\x1b[H");
    await press("\x1b[17~");
    await type("replacement");
    expect(setup.captureCharFrame()).not.toContain("replace this line");
    const beforeUndo = setup.captureCharFrame();
    expect(beforeUndo).toContain("replacement");
    await press("z", true);
    expect(setup.captureCharFrame()).not.toBe(beforeUndo);
    await press("y", true);
    expect(setup.captureCharFrame()).toBe(beforeUndo);
    await press("\x1b[18~");
    await type("final");
    await press("return");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "submit", text: "final" });
  } finally {
    setup.renderer.destroy();
  }
});
