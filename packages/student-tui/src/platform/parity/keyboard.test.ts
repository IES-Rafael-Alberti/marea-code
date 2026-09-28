import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { expect, it, vi } from "vitest";
import { handleParityKey, type KeyboardContext } from "./keyboard.js";
import { createPresentation } from "../../parity/presentation.js";
import { PARITY_TEST_COPY as copy } from "../../../test-support/parity-copy.js";

function fixture() {
  const dispatch = vi.fn();
  const presentation = createPresentation(
    { cwd: "/p", branch: "", model: "", repositoryUrl: "" },
    copy,
    dispatch,
    { entries: ["older"], remember: vi.fn() },
  );
  presentation.sync({ approval: null, messages: [], status: "ready" });
  const scrollBy = vi.fn();
  const scrollChildIntoView = vi.fn();
  const context = {
    approvalKeys: false,
    copy,
    draft: "draft",
    editor: { plainText: "draft", logicalCursor: { row: 0 }, lineCount: 1 } as TextareaRenderable,
    focus: "composer",
    height: 24,
    presentation,
    scroll: {
      scrollBy,
      scrollChildIntoView,
    } as Partial<ScrollBoxRenderable> as ScrollBoxRenderable,
    targets: ["tool:e1", "composer"],
    activate: vi.fn(),
    dispatch,
    focusOn: vi.fn(),
    replaceDraft: vi.fn(),
  } satisfies KeyboardContext;
  const key = (
    name: string,
    overrides: Partial<KeyboardContext> = {},
    ctrl = false,
    shift = false,
  ) => handleParityKey({ name, ctrl, shift }, { ...context, ...overrides });
  return { context, key, scrollBy, scrollChildIntoView, dispatch };
}

it("routes global controls and preserves native editing keys", () => {
  const { context, key, scrollBy, scrollChildIntoView, dispatch } = fixture();
  expect(key("x")).toBe(false);
  expect(key("q", {}, true)).toBe(true);
  expect(key("d", {}, true)).toBe(true);
  expect(key("escape")).toBe(true);
  expect(dispatch.mock.calls).toEqual([
    [{ type: "exit" }],
    [{ type: "exit" }],
    [{ type: "cancel" }],
  ]);
  expect(key("pageup")).toBe(true);
  expect(key("pagedown")).toBe(true);
  expect(scrollBy.mock.calls).toEqual([[-20], [20]]);
  key("pageup", { height: 2 });
  key("pagedown", { height: 2 });
  expect(scrollBy.mock.calls.slice(-2)).toEqual([[-1], [1]]);
  key("pageup", { scroll: null });
  key("pagedown", { scroll: null });
  expect(key("y", { approvalKeys: true, focus: "approve" })).toBe(true);
  expect(key("n", { approvalKeys: true, focus: "reject" })).toBe(true);
  expect(key("y", { focus: "reason" })).toBe(false);
  for (const name of ["return", "enter", "space"])
    expect(key(name, { focus: "tool:e1" })).toBe(true);
  expect(context.activate).toHaveBeenCalledWith("approve");
  expect(context.activate).toHaveBeenCalledWith("reject");
  expect(context.activate).toHaveBeenLastCalledWith("tool:e1");
  expect(key("return", { focus: "answer" })).toBe(false);
  expect(key("o", {}, true)).toBe(true);
  expect(key("e", {}, true)).toBe(false);
  expect(key("e", { draft: "" }, true)).toBe(true);
  expect(scrollChildIntoView).not.toHaveBeenCalled();
});

it("completes commands, cycles focus and restores history only at editor boundaries", () => {
  const { context, key } = fixture();
  key("tab", { draft: "/he" });
  expect(context.replaceDraft).toHaveBeenLastCalledWith("/help");
  key("tab", { draft: "/unknown" });
  expect(context.focusOn).toHaveBeenLastCalledWith("tool:e1");
  key("tab", { draft: "/he" }, false, true);
  expect(context.focusOn).toHaveBeenLastCalledWith("tool:e1");
  key("tab", { focus: "tool:e1" });
  expect(context.focusOn).toHaveBeenLastCalledWith("composer");
  expect(key("up")).toBe(true);
  expect(context.replaceDraft).toHaveBeenLastCalledWith("older");
  expect(key("up")).toBe(false);
  expect(key("down")).toBe(true);
  expect(context.replaceDraft).toHaveBeenLastCalledWith("draft");
  expect(key("down")).toBe(false);
  expect(key("up", { editor: null })).toBe(false);
  expect(key("down", { editor: null })).toBe(false);
  const editor = {
    plainText: "first\nsecond",
    logicalCursor: { row: 1 },
    lineCount: 2,
  } as TextareaRenderable;
  expect(key("up", { editor, draft: editor.plainText })).toBe(false);
  editor.logicalCursor.row = 0;
  expect(key("down", { editor, draft: editor.plainText })).toBe(false);
});

it("scrolls toggled outputs into view without moving the editor focus", () => {
  const { context, key, scrollChildIntoView } = fixture();
  context.presentation.sync({
    approval: null,
    messages: [],
    status: "ready",
    tools: [
      { callId: "a", name: "read", arguments: {}, outcome: { result: "first", failed: false } },
      { callId: "b", name: "read", arguments: {}, outcome: { result: "last", failed: false } },
    ],
  });
  const id = context.presentation
    .snapshot()
    .transcript.findLast((entry) => entry.kind === "tool")?.id;
  key("o", {}, true);
  expect(scrollChildIntoView).toHaveBeenLastCalledWith(id);
  expect(
    context.presentation
      .snapshot()
      .transcript.filter((entry) => entry.kind === "tool")
      .map((entry) => entry.row.expanded),
  ).toEqual([false, true]);
  key("e", { draft: "" }, true);
  expect(scrollChildIntoView).toHaveBeenCalledTimes(2);
  expect(context.focusOn).not.toHaveBeenCalled();
  key("o", { scroll: null }, true);
});

it("leaves field activation and multiline navigation to the native editor", () => {
  const { context, key } = fixture();
  for (const focus of ["composer", "answer", "reason"]) {
    expect(key("return", { focus })).toBe(false);
  }
  key("tab", { focus: "tool:e1", draft: "/he" });
  expect(context.replaceDraft).not.toHaveBeenCalled();
  expect(context.focusOn).toHaveBeenLastCalledWith("composer");
  const editor = {
    plainText: "first\nsecond",
    logicalCursor: { row: 0 },
    lineCount: 2,
  } as TextareaRenderable;
  expect(key("up", { editor, draft: editor.plainText })).toBe(true);
  expect(context.replaceDraft).toHaveBeenLastCalledWith("older");
  expect(key("down", { editor, draft: editor.plainText })).toBe(false);
  editor.logicalCursor.row = 1;
  expect(key("down", { focus: "answer", editor })).toBe(false);
  expect(key("down", { editor, draft: editor.plainText })).toBe(true);
  expect(context.replaceDraft).toHaveBeenLastCalledWith("first\nsecond");
  expect(key("down", { focus: "answer", editor })).toBe(false);
  expect(key("up", { focus: "reason", editor })).toBe(false);
  key("tab", { draft: " /he" });
  expect(context.replaceDraft).toHaveBeenLastCalledWith("/help");
});

it("selects the logical line with F6 only in the mounted composer", () => {
  const { key } = fixture();
  const gotoLineTextEnd = vi.fn();
  const setSelection = vi.fn();
  const editor = {
    gotoLineTextEnd,
    setSelection,
    editBuffer: { getEOL: () => ({ row: 0, offset: 4 }), getLineStartOffset: () => 0 },
  } as unknown as TextareaRenderable;
  expect(key("f6", { editor })).toBe(true);
  expect(gotoLineTextEnd).toHaveBeenCalledOnce();
  expect(setSelection).toHaveBeenCalledExactlyOnceWith(0, 4);
  expect(key("f6", { editor: null })).toBe(false);
  expect(key("f6", { editor, focus: "answer" })).toBe(false);
});

it("leaves Ctrl+Shift+C to the terminal instead of exiting", () => {
  const { key, dispatch } = fixture();
  expect(key("c", {}, true, true)).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});
