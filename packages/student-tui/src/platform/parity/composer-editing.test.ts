import type { TextareaRenderable } from "@opentui/core";
import { expect, it, vi } from "vitest";
import { editComposer } from "./composer-editing.js";

it("selects a whole logical line and leaves modified F6 to the terminal", () => {
  const gotoLineTextEnd = vi.fn();
  const setSelection = vi.fn();
  const getLineStartOffset = vi.fn(() => 11);
  const editor = {
    gotoLineTextEnd,
    setSelection,
    editBuffer: { getEOL: () => ({ row: 2, offset: 15 }), getLineStartOffset },
  } as unknown as TextareaRenderable;
  expect(editComposer({ name: "f6", ctrl: false, shift: false }, editor)).toBe(true);
  expect(gotoLineTextEnd).toHaveBeenCalledOnce();
  expect(getLineStartOffset).toHaveBeenCalledExactlyOnceWith(2);
  expect(setSelection).toHaveBeenCalledExactlyOnceWith(11, 15);
  expect(editComposer({ name: "f6", ctrl: true, shift: false }, editor)).toBe(false);
  expect(editComposer({ name: "f6", ctrl: false, shift: true }, editor)).toBe(false);
});

it.each([
  { end: 0, cursor: 0, selected: false, action: "deleteLine" },
  { end: 4, cursor: 4, selected: false, action: "deleteChar" },
  { end: 4, cursor: 2, selected: false, action: "deleteToLineEnd" },
  { end: 4, cursor: 4, selected: true, action: "deleteToLineEnd" },
])(
  "Ctrl+K uses $action at end=$end cursor=$cursor selection=$selected",
  ({ end, cursor, selected, action }) => {
    const calls = { deleteLine: vi.fn(), deleteChar: vi.fn(), deleteToLineEnd: vi.fn() };
    const editor = {
      ...calls,
      logicalCursor: { col: cursor },
      hasSelection: () => selected,
      editBuffer: { getEOL: () => ({ col: end }) },
    } as unknown as TextareaRenderable;
    expect(editComposer({ name: "k", ctrl: true, shift: false }, editor)).toBe(true);
    expect(
      Object.entries(calls)
        .filter(([, call]) => call.mock.calls.length > 0)
        .map(([name]) => name),
    ).toEqual([action]);
    expect(editComposer({ name: "k", ctrl: false, shift: false }, editor)).toBe(false);
    expect(editComposer({ name: "k", ctrl: true, shift: true }, editor)).toBe(false);
  },
);
