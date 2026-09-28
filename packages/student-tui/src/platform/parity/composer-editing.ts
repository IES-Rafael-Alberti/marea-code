import type { TextareaRenderable } from "@opentui/core";
import type { KeyPress } from "../../parity/keys.js";

/** Textual editing operations that do not have an equivalent native binding. */
export function editComposer(key: KeyPress, editor: TextareaRenderable): boolean {
  if (key.shift) return false;
  if (key.name === "f6" && !key.ctrl) {
    const end = editor.editBuffer.getEOL();
    const start = editor.editBuffer.getLineStartOffset(end.row);
    editor.gotoLineTextEnd();
    editor.setSelection(start, end.offset);
    return true;
  }
  if (key.name !== "k" || !key.ctrl) return false;
  const end = editor.editBuffer.getEOL();
  if (end.col === 0) editor.deleteLine();
  else if (!editor.hasSelection() && editor.logicalCursor.col === end.col) editor.deleteChar();
  else editor.deleteToLineEnd();
  return true;
}
