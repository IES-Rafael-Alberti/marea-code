import { getTreeSitterClient } from "@opentui/core";
import { registerReferenceMarkdown } from "../src/platform/reference-markdown.boundary.js";
/** @jsxImportSource @opentui/react */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { registerReferenceBoxes } from "../src/platform/reference-box.boundary.js";
import { installTerminalControls } from "../src/platform/terminal-controls.js";
import { LiveParityScreen } from "../src/platform/parity/live-screen.js";
import { createPresentation } from "../src/parity/presentation.js";
import { PARITY_TEST_COPY as copy } from "../test-support/parity-copy.js";
registerReferenceBoxes();
registerReferenceMarkdown(getTreeSitterClient());

it("copies without exiting, cuts/pastes through the real editor and copies a settled mouse selection", async () => {
  const { testRender } = await import("@opentui/react/test-utils");
  const nativeCopy = vi.fn(() => Promise.resolve(false));
  const dispatch = vi.fn();
  const presentation = newPresentation(dispatch);
  presentation.sync({
    approval: null,
    messages: [{ author: "marea", text: "Drag this sentence" }],
    status: "ready",
  });
  presentation.present({
    type: "tool-started",
    callId: "call",
    name: "read_file",
    arguments: { filePath: "example.txt" },
  });
  presentation.present({
    type: "tool-finished",
    callId: "call",
    result: "Tool output to select",
    failed: false,
  });
  const setup = await testRender(
    <LiveParityScreen copy={copy} presentation={presentation} onAction={dispatch} />,
    { width: 80, height: 24, exitOnCtrlC: false, kittyKeyboard: true },
  );
  const osc = vi.spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
  const release = installTerminalControls(setup.renderer, nativeCopy);
  const press = async (name: string, ctrl = false) =>
    act(async () => {
      setup.mockInput.pressKey(name, { ctrl });
      await setup.flush();
    });
  try {
    await setup.flush();
    await act(async () => {
      await setup.mockInput.typeText("copy me");
      await setup.flush();
    });
    await press("F7");
    await press("c", true);
    expect(nativeCopy).toHaveBeenLastCalledWith("copy me");
    expect(osc).toHaveBeenLastCalledWith("copy me");
    expect(dispatch).not.toHaveBeenCalled();
    await press("x", true);
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
    await press("v", true);
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("copy me");
    const frame = await setup.waitForFrame((value) => value.includes("Drag this sentence"));
    const rows = frame.split("\n");
    const row = rows.findIndex((line) => line.includes("Drag this sentence"));
    const column = rows[row]?.indexOf("Drag") ?? -1;
    expect(row).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await setup.mockMouse.drag(column, row, column + 3, row);
      await setup.flush();
    });
    expect(nativeCopy).toHaveBeenLastCalledWith("Drag");
    expect(dispatch).not.toHaveBeenCalled();
    const toolRows = setup.captureCharFrame().split("\n");
    const toolY = toolRows.findIndex((line) => line.includes("read  example.txt"));
    const toolX = toolRows[toolY]?.indexOf("read") ?? -1;
    const toolExpanded = () =>
      presentation.snapshot().transcript.find((entry) => entry.kind === "tool");
    await act(async () => {
      await setup.mockMouse.drag(toolX, toolY, toolX + 3, toolY);
      await setup.flush();
    });
    expect(nativeCopy).toHaveBeenLastCalledWith("read");
    expect(toolExpanded()).toMatchObject({ row: { expanded: false } });
    await act(async () => {
      await setup.mockMouse.click(toolX, toolY);
      await setup.flush();
    });
    expect(toolExpanded()).toMatchObject({ row: { expanded: true } });
  } finally {
    release();
    act(() => {
      setup.renderer.destroy();
    });
  }
});

it("scrolls with the wheel, preserves the draft through resize, and hints instead of quitting on Ctrl+C", async () => {
  const { testRender } = await import("@opentui/react/test-utils");
  const dispatch = vi.fn();
  const presentation = newPresentation(dispatch);
  presentation.sync({ approval: null, messages: [], status: "ready" });
  presentation.present({
    type: "assistant-text",
    text: Array.from({ length: 60 }, (_, i) => `Paragraph ${String(i)}\n\n`).join(""),
  });
  const setup = await testRender(
    <LiveParityScreen copy={copy} presentation={presentation} onAction={dispatch} />,
    { width: 80, height: 24, exitOnCtrlC: false, kittyKeyboard: true },
  );
  const release = installTerminalControls(setup.renderer, () => Promise.resolve(false));
  try {
    await setup.flush();
    const bottom = setup.captureCharFrame();
    expect(bottom).toContain("Paragraph 59");
    await act(async () => {
      await setup.mockMouse.scroll(10, 5, "up");
      await setup.mockMouse.scroll(10, 5, "up");
      await setup.flush();
    });
    expect(setup.captureCharFrame()).not.toBe(bottom);
    presentation.present({ type: "assistant-text", text: "A newly arrived final paragraph\n\n" });
    await act(async () => {
      await setup.mockInput.typeText("saved draft");
      await setup.flush();
    });
    expect(setup.captureCharFrame()).not.toContain("A newly arrived final paragraph");
    await act(async () => {
      setup.resize(64, 20);
      await setup.flush();
    });
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("saved draft");
    await act(async () => {
      setup.resize(120, 40);
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toContain("saved draft");
    await act(async () => {
      setup.mockInput.pressCtrlC();
      await setup.flush();
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain(copy.notices.quitHint);
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    release();
    act(() => {
      setup.renderer.destroy();
    });
  }
});

function newPresentation(dispatch: Parameters<typeof createPresentation>[2]) {
  return createPresentation(
    { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
    copy,
    dispatch,
  );
}
