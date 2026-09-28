import { EventEmitter } from "node:events";
import type { CliRenderer } from "@opentui/core";
import { expect, it, vi } from "vitest";
import { installTerminalControls } from "./terminal-controls.js";

function setup() {
  const editor = {
    getSelectedText: vi.fn(() => "selection"),
    deleteSelection: vi.fn(),
    deleteLine: vi.fn(),
    insertText: vi.fn(),
    logicalCursor: { row: 1 },
    plainText: "first\nsecond\nthird",
  };
  const selected = { getSelectedText: vi.fn(() => "mouse selection") };
  const focused: { currentFocusedEditor: typeof editor | null } = { currentFocusedEditor: editor };
  const renderer = Object.assign(new EventEmitter(), focused, {
    getSelection: vi.fn((): typeof selected | null => selected),
    copyToClipboardOSC52: vi.fn(),
    keyInput: new EventEmitter(),
  });
  const native = vi.fn(() => Promise.resolve(true));
  const release = installTerminalControls(renderer as unknown as CliRenderer, native);
  const press = (name: string, properties = {}) => {
    const key = {
      name,
      ctrl: true,
      shift: false,
      super: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...properties,
    };
    renderer.keyInput.emit("keypress", key);
    return key;
  };
  return { editor, selected, renderer, native, release, press };
}

it("copies the settled drag, uses both transports and removes listeners on exit", async () => {
  const t = setup();
  const notice = vi.fn();
  t.renderer.on("marea:copied", notice);
  t.renderer.emit("selection", t.selected);
  t.selected.getSelectedText.mockReturnValue("settled");
  await Promise.resolve();
  expect(t.renderer.copyToClipboardOSC52).toHaveBeenCalledExactlyOnceWith("settled");
  expect(t.native).toHaveBeenCalledExactlyOnceWith("settled");
  expect(notice).toHaveBeenCalledOnce();
  t.renderer.emit("selection", t.selected);
  t.release();
  await Promise.resolve();
  t.press("c");
  expect(t.native).toHaveBeenCalledTimes(1);
  expect(t.renderer.listenerCount("selection")).toBe(0);
  expect(t.renderer.keyInput.listenerCount("keypress")).toBe(0);
});

it("copies/cuts editor selections, pastes locally, and cuts the cursor line without a selection", () => {
  const t = setup();
  expect(t.press("c").preventDefault).toHaveBeenCalledOnce();
  expect(t.native).toHaveBeenLastCalledWith("selection");
  t.editor.getSelectedText.mockReturnValue("different cut");
  expect(t.press("x").stopPropagation).toHaveBeenCalledOnce();
  expect(t.editor.deleteSelection).toHaveBeenCalledOnce();
  t.press("v");
  expect(t.editor.insertText).toHaveBeenLastCalledWith("different cut");
  expect(t.editor.deleteSelection).toHaveBeenCalledTimes(2);
  t.editor.getSelectedText.mockReturnValue("");
  t.press("x");
  expect(t.native).toHaveBeenLastCalledWith("second\n");
  expect(t.editor.deleteLine).toHaveBeenCalledOnce();
  t.press("v");
  expect(t.editor.insertText).toHaveBeenLastCalledWith("second\n");
  t.release();
});

it("leaves ordinary and terminal shortcuts alone and copies a transcript selection", () => {
  const t = setup();
  for (const key of [
    t.press("c", { shift: true }),
    t.press("c", { ctrl: false }),
    t.press("a"),
    t.press("v", { ctrl: false, super: true }),
  ])
    expect(key.preventDefault).not.toHaveBeenCalled();
  t.renderer.currentFocusedEditor = null;
  t.press("c", { ctrl: false, super: true });
  expect(t.native).toHaveBeenLastCalledWith("mouse selection");
  expect(t.press("x").preventDefault).not.toHaveBeenCalled();
  expect(t.press("v").preventDefault).not.toHaveBeenCalled();
  t.renderer.getSelection.mockReturnValue(null);
  const hint = vi.fn();
  t.renderer.on("marea:quit-hint", hint);
  expect(t.press("c").preventDefault).toHaveBeenCalledOnce();
  expect(hint).toHaveBeenCalledOnce();
  t.release();
});

it("keeps local copy/paste usable when OSC 52 and the native transport fail", async () => {
  const t = setup();
  t.renderer.copyToClipboardOSC52.mockImplementation(() => {
    throw new Error("closed");
  });
  t.native.mockRejectedValue(new Error("unavailable"));
  t.press("c");
  t.press("v");
  await Promise.resolve();
  expect(t.editor.insertText).toHaveBeenCalledExactlyOnceWith("selection");
  t.selected.getSelectedText.mockReturnValue("");
  t.renderer.emit("selection", t.selected);
  await Promise.resolve();
  expect(t.native).toHaveBeenCalledTimes(1);
  t.release();
});

it("cuts the last line without adding a newline and handles an empty buffer", () => {
  const t = setup();
  t.editor.getSelectedText.mockReturnValue("");
  t.editor.logicalCursor.row = 2;
  t.press("x");
  expect(t.native).toHaveBeenLastCalledWith("third");
  t.editor.logicalCursor.row = 0;
  t.editor.plainText = "";
  t.press("x");
  expect(t.native).toHaveBeenCalledTimes(1);
  expect(t.editor.deleteLine).toHaveBeenCalledTimes(2);
  t.release();
});

it("pasting before copying uses an empty private clipboard and replaces a selection", () => {
  const t = setup();
  t.press("v");
  expect(t.editor.insertText).toHaveBeenCalledExactlyOnceWith("");
  expect(t.editor.deleteSelection).toHaveBeenCalledOnce();
  t.release();
});
