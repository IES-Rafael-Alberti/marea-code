import type { StatusState } from "../../parity/status.js";
import { beforeEach, expect, it, vi } from "vitest";

import type { SyntaxStyle } from "@opentui/core";
import type { ReactElement, SetStateAction } from "react";
import type { ParityScreenProperties } from "./parity-screen.js";

type HookValue =
  | string
  | number
  | SyntaxStyle
  | { pendingId: string | null; stage: string | null; id: string }
  | null;
interface EditorStub {
  plainText: string;
  gotoBufferEnd: () => boolean;
  logicalCursor: { row: number };
  lineCount: number;
  setText: (text: string) => void;
}
interface KeyStub {
  name: string;
  ctrl: boolean;
  shift: boolean;
  preventDefault: () => void;
}
const hooks = vi.hoisted(() => ({
  values: [] as HookValue[],
  cursor: 0,
  refCursor: 0,
  scroll: {
    current: null as null | {
      scrollChildIntoView: ReturnType<typeof vi.fn>;
      scrollBy: ReturnType<typeof vi.fn>;
    },
  },
  editor: { current: null as EditorStub | null },
  key: null as null | ((key: KeyStub) => void),
  cleanup: (): void => undefined,
  dependencies: [] as readonly SyntaxStyle[],
  style: { destroy: vi.fn() },
  styles: vi.fn<(styles: Parameters<typeof SyntaxStyle.fromStyles>[0]) => void>(),
}));

vi.mock("./activity-clock.js", () => ({ useActivityClock: (status: StatusState) => status }));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState<T extends HookValue>(initial: T | (() => T)) {
    const index = hooks.cursor++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.values[index],
      (value: SetStateAction<T>) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index] as T) : value;
      },
    ];
  },
  useRef: () => (hooks.refCursor++ === 0 ? hooks.editor : hooks.scroll),
  useEffect: (effect: () => () => void, dependencies: readonly SyntaxStyle[]) => {
    hooks.dependencies = dependencies;
    hooks.cleanup = effect();
  },
}));
vi.mock("@opentui/core", () => ({
  SyntaxStyle: {
    fromStyles: (styles: Parameters<typeof SyntaxStyle.fromStyles>[0]) => {
      hooks.styles(styles);
      return hooks.style;
    },
  },
}));
vi.mock("@opentui/react", () => ({
  useTerminalDimensions: () => ({ width: 80, height: 24 }),
  useKeyboard: (handler: (key: KeyStub) => void) => {
    hooks.key = handler;
  },
}));

import { PARITY_TEST_COPY } from "../../../test-support/parity-copy.js";
import { createPresentation } from "../../parity/presentation.js";
import { LiveParityScreen } from "./live-screen.js";
import { ParityScreen } from "./parity-screen.js";

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.editor.current = null;
  hooks.scroll.current = { scrollChildIntoView: vi.fn(), scrollBy: vi.fn() };
  vi.clearAllMocks();
});

function harness() {
  const dispatch = vi.fn();
  const presentation = createPresentation(
    { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
    PARITY_TEST_COPY,
    dispatch,
  );
  presentation.sync({ messages: [], approval: null, status: "ready" });
  let updates = 0;
  const render = () => {
    hooks.cursor = 0;
    hooks.refCursor = 0;
    return LiveParityScreen({
      copy: PARITY_TEST_COPY,
      presentation,
      onAction: dispatch,
    }) as ReactElement<ParityScreenProperties>;
  };
  const press = (name: string, ctrl = false, shift = false) => {
    const preventDefault = vi.fn();
    hooks.key?.({ name, ctrl, shift, preventDefault });
    return preventDefault;
  };
  const expectRefresh = () => {
    expect(Number(hooks.values[1])).toBeGreaterThan(updates);
    updates = Number(hooks.values[1]);
  };
  return { dispatch, presentation, render, press, expectRefresh };
}

it("renders the parity screen, preserves busy drafts, and disposes markdown resources", () => {
  const test = harness();
  let node = test.render();
  expect(node.type).toBe(ParityScreen);
  expect(node.props).toMatchObject({
    columns: 80,
    draft: "",
    editor: hooks.editor,
    focusedToolId: null,
    markdownStyle: hooks.style,
  });
  expect(hooks.styles).toHaveBeenCalledWith({
    default: { fg: "#e0e0e0" },
    "markup.heading": { fg: "#0178d4", underline: true },
    "markup.raw": { fg: "#f4bb6e", bg: "#241d13" },
    "markup.link": { fg: "#57a5e2", underline: true },
    "markup.strong": { fg: "#e0e0e0", bold: true },
    "markup.italic": { fg: "#e0e0e0", italic: true },
    "markup.list": { fg: "#57a5e2" },
  });
  node.props.onContentChange();
  expect(test.render().props.draft).toBe("");
  node.props.onSubmit();
  test.expectRefresh();
  node.props.onQuestions({ type: "cancel" });
  test.expectRefresh();
  expect(test.dispatch).not.toHaveBeenCalled();
  const setText = vi.fn();
  hooks.editor.current = {
    plainText: "Draft",
    gotoBufferEnd: vi.fn(() => true),
    logicalCursor: { row: 0 },
    lineCount: 1,
    setText,
  };
  node.props.onContentChange();
  node = test.render();
  expect(node.props.draft).toBe("Draft");
  test.presentation.sync({ messages: [], approval: null, status: "streaming" });
  node.props.onSubmit();
  test.expectRefresh();
  expect(setText).not.toHaveBeenCalled();
  test.presentation.sync({ messages: [], approval: null, status: "ready" });
  node.props.onSubmit();
  test.expectRefresh();
  expect(test.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "submit", text: "Draft" });
  expect(setText).toHaveBeenCalledExactlyOnceWith("");
  expect(test.render().props.draft).toBe("");
  expect(hooks.dependencies).toEqual([hooks.style]);
  hooks.cleanup();
  expect(hooks.style.destroy).toHaveBeenCalledOnce();
});

it("completes slash commands only with unshifted Tab and tolerates an absent editor", () => {
  const test = harness();
  let node = test.render();
  const setText = vi.fn();
  hooks.editor.current = {
    plainText: "/he",
    gotoBufferEnd: vi.fn(() => true),
    logicalCursor: { row: 0 },
    lineCount: 1,
    setText,
  };
  node.props.onContentChange();
  test.render();
  expect(test.press("x")).not.toHaveBeenCalled();
  expect(setText).not.toHaveBeenCalled();
  expect(test.press("tab", false, true)).toHaveBeenCalled();
  expect(test.press("tab")).toHaveBeenCalledOnce();
  expect(setText).toHaveBeenCalledExactlyOnceWith("/help");
  expect(hooks.editor.current.gotoBufferEnd).toHaveBeenCalledOnce();
  expect(test.render().props.draft).toBe("/help");
  hooks.editor.current = null;
  expect(test.press("tab")).toHaveBeenCalledOnce();
  node = test.render();
  for (const plainText of ["/unknown", " /he"]) {
    hooks.editor.current = {
      plainText,
      gotoBufferEnd: vi.fn(() => true),
      logicalCursor: { row: 0 },
      lineCount: 1,
      setText,
    };
    node.props.onContentChange();
    test.render();
    expect(test.press("tab")).toHaveBeenCalled();
  }
});

it("answers structured questions and forwards only the resolved decision", () => {
  const test = harness();
  test.presentation.present({
    type: "questions-asked",
    request: {
      interruptId: "questions:1",
      questions: [{ choices: ["One", "Two"], required: false, text: "Pick one" }],
    },
  });
  const node = test.render();
  node.props.onQuestions({ type: "type", value: "2" });
  expect(test.dispatch).not.toHaveBeenCalled();
  test.expectRefresh();
  expect(test.render().props.session.transcript.at(-1)).toMatchObject({
    questions: { answers: new Map([[0, "2"]]) },
  });
  node.props.onQuestions({ type: "submit" });
  test.expectRefresh();
  expect(test.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "answers",
    interruptId: "questions:1",
    values: ["Two"],
  });
  node.props.onQuestions({ type: "submit" });
  expect(test.dispatch).toHaveBeenCalledTimes(1);
  test.presentation.present({
    type: "questions-asked",
    request: {
      interruptId: "questions:2",
      questions: [{ choices: [], required: false, text: "Free" }],
    },
  });
  test.render().props.onQuestions({ type: "cancel" });
  expect(test.dispatch).toHaveBeenLastCalledWith({ type: "cancel" });
});

it("routes exit and cancellation, and never approves while typing a rejection reason", () => {
  const test = harness();
  test.render();
  test.press("d", true);
  test.press("q", true);
  test.press("escape");
  test.press("c");
  test.press("d");
  test.press("x", true);
  expect(test.dispatch.mock.calls).toEqual([
    [{ type: "exit" }],
    [{ type: "exit" }],
    [{ type: "cancel" }],
  ]);
  const pending = {
    messages: [],
    approval: { path: "notes", summary: "Write", approvalId: "approval:1" },
    status: "approval",
  } as const;
  test.presentation.sync(pending);
  test.render();
  test.press("x");
  expect(test.presentation.snapshot().transcript.at(-1)).toMatchObject({
    approval: { stage: "deciding" },
  });
  test.press("n");
  test.expectRefresh();
  expect(test.presentation.snapshot().transcript.at(-1)).toMatchObject({
    approval: { stage: "rejecting" },
  });
  test.render();
  test.press("y");
  expect(test.dispatch).toHaveBeenCalledTimes(3);
  const node = test.render();
  node.props.onApproval({ type: "set-reason", reason: "Why" });
  test.expectRefresh();
  node.props.onApproval({ type: "confirm-reject" });
  test.expectRefresh();
  expect(test.dispatch).toHaveBeenLastCalledWith({
    type: "reject",
    interruptId: "approval:1",
    reason: "Why",
  });
  test.presentation.sync({ messages: [], approval: null, status: "streaming" });
  test.presentation.sync({
    ...pending,
    approval: { ...pending.approval, approvalId: "approval:2" },
  });
  test.render();
  test.press("y");
  test.expectRefresh();
  expect(test.dispatch).toHaveBeenLastCalledWith({ type: "approve", interruptId: "approval:2" });
});

it("activates tools, preview, retry and question navigation through the focus controller", () => {
  const test = harness();
  test.presentation.sync({
    messages: [],
    approval: null,
    status: "ready",
    tools: [
      { callId: "t1", name: "read", arguments: {}, outcome: { failed: false, result: "output" } },
    ],
  });
  let node = test.render();
  node.props.interaction?.activate("tool:e1");
  test.expectRefresh();
  expect(test.presentation.snapshot().transcript.at(-1)).toMatchObject({ row: { expanded: true } });
  expect(hooks.scroll.current?.scrollChildIntoView).toHaveBeenLastCalledWith("e1");
  expect(test.render().props.interaction?.focus).toBe("tool:e1");
  test.presentation.sync({
    messages: [],
    approval: { approvalId: "review", path: "a", content: "Contents", summary: "Write" },
    status: "approval",
  });
  node = test.render();
  const approve = vi.spyOn(test.presentation, "approve");
  node.props.interaction?.activate("preview");
  expect(approve).toHaveBeenLastCalledWith({ type: "toggle-preview" });
  expect(test.presentation.snapshot().transcript.at(-1)).toMatchObject({
    approval: { expanded: true },
  });
  node.props.interaction?.activate("approve");
  expect(approve).toHaveBeenLastCalledWith({ type: "approve" });
  expect(test.dispatch).toHaveBeenLastCalledWith({ type: "approve", interruptId: "review" });
  test.presentation.sync({
    messages: [],
    approval: null,
    status: "questions",
    questions: {
      interruptId: "q",
      questions: [
        { text: "A", choices: [], required: false },
        { text: "B", choices: [], required: false },
      ],
    },
  });
  node = test.render();
  node.props.interaction?.activate("next");
  node = test.render();
  expect(node.props.interaction?.focus).toBe("answer");
  node.props.interaction?.activate("previous");
  node = test.render();
  expect(node.props.session.transcript.at(-1)).toMatchObject({ questions: { index: 0 } });
  node.props.interaction?.focusOn("answer");
  expect(hooks.scroll.current?.scrollChildIntoView).toHaveBeenLastCalledWith(
    node.props.session.pendingId,
  );
  node.props.interaction?.activate("unknown");
  expect(test.render().props.session.transcript.at(-1)).toMatchObject({
    questions: { index: 0, resolved: false },
  });
  test.presentation.sync({
    messages: [],
    approval: null,
    status: "failed",
    failure: {
      detail: "",
      kind: "unexpected",
      hasPrefix: false,
      recoverable: true,
      retryable: true,
    },
  });
  node = test.render();
  const error = node.props.session.transcript.find((entry) => entry.kind === "error");
  node.props.interaction?.activate(`retry:${error?.id ?? "missing"}`);
  expect(test.dispatch).toHaveBeenLastCalledWith({ type: "retry" });
  expect(hooks.scroll.current?.scrollChildIntoView).toHaveBeenLastCalledWith(error?.id);
});

it("restores input focus across distinct interrupts, stage changes and withdrawn actions", () => {
  const test = harness();
  const question = (interruptId: string) => ({
    type: "questions-asked" as const,
    request: {
      interruptId,
      questions: [
        { text: "One", choices: [], required: false },
        { text: "Two", choices: [], required: false },
      ],
    },
  });
  test.presentation.present(question("q1"));
  let node = test.render();
  node.props.interaction?.focusOn("next");
  expect(test.render().props.interaction?.focus).toBe("next");
  test.presentation.present(question("q2"));
  node = test.render();
  expect(node.props.interaction?.focus).toBe("answer");
  node.props.interaction?.activate("next");
  expect(test.render().props.session.transcript.at(-1)).toMatchObject({ questions: { index: 1 } });
  test.expectRefresh();
  node = test.render();
  node.props.interaction?.activate("answer");
  expect(test.render().props.session.transcript.at(-1)).toMatchObject({ questions: { index: 1 } });
  node.props.onQuestions({ type: "cancel" });
  test.presentation.present({
    type: "approval-requested",
    request: {
      interruptId: "a",
      name: "write_file",
      arguments: { content: "full" },
      preview: "short",
      warnings: [],
    },
  });
  node = test.render();
  expect(node.props.interaction?.focus).toBe("approve");
  node.props.interaction?.activate("preview");
  expect(test.render().props.interaction?.focus).toBe("preview");
  node = test.render();
  node.props.onApproval({ type: "start-reject" });
  expect(test.render().props.interaction?.focus).toBe("reason");
  node = test.render();
  node.props.interaction?.focusOn("gone");
  expect(test.render().props.interaction?.focus).toBe("reason");
  node.props.onApproval({ type: "cancel" });
  node = test.render();
  expect(node.props.interaction?.focus).toBe("composer");
  hooks.scroll.current?.scrollChildIntoView.mockClear();
  node.props.interaction?.focusOn("composer");
  expect(hooks.scroll.current?.scrollChildIntoView).not.toHaveBeenCalled();
  node.props.interaction?.activate("next");
  test.expectRefresh();
  hooks.scroll.current = null;
  node.props.interaction?.focusOn("tool:e1");
});

it("refreshes a keyboard output toggle and restores approval input after inspecting an old tool", () => {
  const test = harness();
  test.presentation.sync({
    approval: null,
    messages: [],
    status: "ready",
    tools: [
      { callId: "t", name: "read", arguments: {}, outcome: { failed: false, result: "done" } },
    ],
  });
  test.render();
  test.press("o", true);
  test.expectRefresh();
  test.presentation.present({
    type: "approval-requested",
    request: {
      interruptId: "a",
      name: "write_file",
      arguments: {},
      preview: "write",
      warnings: [],
    },
  });
  let node = test.render();
  node.props.interaction?.focusOn("tool:e1");
  node = test.render();
  expect(node.props.interaction?.focus).toBe("tool:e1");
  node.props.onApproval({ type: "start-reject" });
  expect(test.render().props.interaction?.focus).toBe("reason");
});
