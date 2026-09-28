import type { CliRenderer, KeyEvent, Selection } from "@opentui/core";
import { copyNativeClipboard } from "./clipboard.boundary.js";

/** Trusted UI actions alone may emit OSC 52; model text never enters this port directly. */
export function installTerminalControls(
  renderer: CliRenderer,
  nativeCopy: (text: string) => Promise<boolean> = copyNativeClipboard,
): () => void {
  let clipboard: string | null = null;
  let disposed = false;
  const copy = (text: string) => {
    if (text === "" || disposed) return;
    clipboard = text;
    try {
      renderer.copyToClipboardOSC52(text);
    } catch {
      // A terminal transport failure must not lose the local clipboard.
    }
    renderer.emit("marea:copied");
    void nativeCopy(text).catch(() => {
      /* Native failure leaves the local clipboard usable. */
    });
  };
  const selected = (selection: Selection) => {
    queueMicrotask(() => {
      copy(selection.getSelectedText());
    });
  };
  const keypress = (key: KeyEvent) => {
    if (key.shift || !(key.ctrl || key.super)) return;
    const editor = renderer.currentFocusedEditor;
    if (key.name === "c") {
      const selectedText = editor?.getSelectedText() ?? "";
      const text =
        selectedText === "" ? (renderer.getSelection()?.getSelectedText() ?? "") : selectedText;
      if (text === "") renderer.emit("marea:quit-hint");
      else copy(text);
    } else if (key.name === "x" && editor !== null) {
      const selection = editor.getSelectedText();
      if (selection !== "") {
        copy(selection);
        editor.deleteSelection();
      } else {
        const row = editor.logicalCursor.row;
        const lines = editor.plainText.split("\n");
        const text = lines.slice(row, row + 1).join();
        copy(row < lines.length - 1 ? text + "\n" : text);
        editor.deleteLine();
      }
    } else if (key.name === "v" && key.ctrl && editor !== null) {
      editor.deleteSelection();
      editor.insertText(clipboard ?? "");
    } else return;
    key.preventDefault();
    key.stopPropagation();
  };
  renderer.on("selection", selected);
  renderer.keyInput.prependListener("keypress", keypress);
  return () => {
    disposed = true;
    renderer.off("selection", selected);
    renderer.keyInput.off("keypress", keypress);
    clipboard = null;
  };
}
