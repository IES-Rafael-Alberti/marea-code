import { expect, it, vi } from "vitest";
import { nodesOfType, renderedText } from "../../../test-support/element-tree.boundary.js";
import { PARITY_TEST_COPY as copy } from "../../../test-support/parity-copy.js";
import { openApproval } from "../../parity/approval.js";
import { openQuestions, questionsReducer } from "../../parity/questions.js";
import { INITIAL_STATUS } from "../../parity/status.js";
import { ApprovalPanel } from "./approval-panel.js";
import { QuestionsPanel } from "./questions-panel.js";
import { ReferenceButton, ReferenceInput } from "./reference-controls.js";
import { Composer, CommandSuggestions } from "./composer.js";
import { Conversation } from "./conversation.js";
import { StatusBar } from "./status-bar.js";

const interaction = (focus: string) => ({
  focus,
  scroll: null,
  activate: vi.fn(),
  focusOn: vi.fn(),
});
const request = {
  interruptId: "i",
  name: "execute",
  arguments: {},
  preview: "",
  warnings: [] as string[],
};

it.each([
  ["", [], undefined, 1],
  ["", ["warning"], undefined, 0],
  ["one\ntwo", [], 2, 0],
  ["one\ntwo", ["warning"], 2, 0],
  ["x\n".repeat(30), [], 18, 0],
] as const)(
  "bounds preview height and collapses adjacent margins (%s)",
  (preview, warnings, height, margin) => {
    const tree = ApprovalPanel({
      copy: copy.approval,
      onAction: vi.fn(),
      state: openApproval({ ...request, preview, warnings: [...warnings] }),
    });
    expect(nodesOfType(tree, "referenceScrollbox").length).toBe(height === undefined ? 0 : 1);
    expect(
      nodesOfType(tree, "box").find((node) => node.props.flexDirection === "row")?.props.marginTop,
    ).toBe(margin);
  },
);
it.each(["approve", "reject", "preview"])(
  "shows the actual focused authorization action (%s)",
  (focus) => {
    const tree = ApprovalPanel({
      copy: copy.approval,
      onAction: vi.fn(),
      state: openApproval(request),
      interaction: interaction(focus),
    });
    const buttons = nodesOfType(tree, "referenceBox");
    expect(buttons[0]?.props.backgroundColor).toBe(focus === "approve" ? "#55c076" : "#4ebf71");
    expect(nodesOfType(buttons[0]?.children ?? null, "text")[0]?.props.fg).toBe(
      focus === "approve" ? "#55c076" : "#0a180e",
    );
    expect(nodesOfType(buttons[1]?.children ?? null, "text")[0]?.props.fg).toBe(
      focus === "reject" ? "#b93c5b" : "#f5e5e9",
    );
  },
);
it.each(["previous", "next", "answer"])("shows focus while navigating questions (%s)", (focus) => {
  const state = questionsReducer(
    openQuestions({
      interruptId: "q",
      questions: [
        { text: "a", choices: [], required: false },
        { text: "b", choices: [], required: false },
      ],
    }),
    { type: "next" },
  );
  const tree = QuestionsPanel({
    copy: copy.question,
    onAction: vi.fn(),
    state,
    interaction: interaction(focus),
  });
  const buttons = nodesOfType(tree, "referenceBox").filter(
    (node) => typeof node.props.onMouseDown === "function",
  );
  expect(nodesOfType(buttons[0]?.children ?? null, "text")[0]?.props.fg).toBe(
    focus === "previous" ? "#1e1e1e" : "#e0e0e0",
  );
  expect(nodesOfType(buttons[1]?.children ?? null, "text")[0]?.props.fg).toBe(
    focus === "next" ? "#0178d4" : "#ddedf9",
  );
});
it("keeps disabled answers readable and sizes full button labels with padding", () => {
  expect(nodesOfType(ReferenceInput({ readOnly: true, value: "kept" }), "text")[0]?.props.fg).toBe(
    "#a5a5a5",
  );
  expect(
    nodesOfType(ReferenceInput({ readOnly: true, value: "", placeholder: "answer" }), "text")[0]
      ?.props.fg,
  ).toBe("#595959");
  for (const label of ["Yes", "A sufficiently long action"]) {
    const tree = ReferenceButton({
      label,
      background: "#1e1e1e",
      focused: false,
      onPress: vi.fn(),
    });
    expect(nodesOfType(tree, "referenceBox")[0]?.props.border).toEqual(["top", "bottom"]);
    expect(nodesOfType(tree, "referenceBox")[0]?.props.referenceBottomColor).toBe("#0d0d0d");
    expect(nodesOfType(tree, "referenceBox")[0]?.props.width).toBe(label === "Yes" ? 16 : 28);
  }
});
it.each([
  [false, undefined, "tall"],
  [false, true, "tall"],
  [false, false, null],
  [true, true, null],
] as const)("keeps composer focus distinct from disabling (%s/%s)", (disabled, focused, border) => {
  const tree = Composer({
    canSubmit: true,
    disabled,
    ...(focused === undefined ? {} : { focused }),
    editor: null,
    onContentChange: vi.fn(),
    onSubmit: vi.fn(),
    placeholder: "write",
  });
  expect(nodesOfType(tree, "referenceBox")[0]?.props.referenceBorder).toBe(border);
});
it("distinguishes commands from descriptions in the suggestion strip", () => {
  const tree = CommandSuggestions({ copy: copy.commands, text: "/" });
  const spans = nodesOfType(tree, "span");
  expect(spans[0]?.props).toMatchObject({ fg: "#b0245e", attributes: 1 });
  expect(spans[1]?.props).toMatchObject({ fg: "#777777", attributes: 0 });
});
it.each(["retry:e1", "composer"])(
  "keeps conversation anchoring, scroll appearance and retry focus (%s)",
  (focus) => {
    const tree = Conversation({
      columns: 80,
      copy,
      markdownStyle: {} as never,
      focusedToolId: null,
      onApproval: vi.fn(),
      onQuestions: vi.fn(),
      interaction: interaction(focus),
      transcript: [
        {
          id: "e1",
          kind: "error",
          message: "Interrupted",
          detail: "Resume",
          retryable: true,
          retryOffered: true,
        },
      ],
    });
    expect(nodesOfType(tree, "referenceConversation")[0]?.props.contentOptions).toEqual({
      minHeight: "100%",
      justifyContent: "flex-end",
    });
    expect(nodesOfType(tree, "referenceConversation")[0]?.props.verticalScrollbarOptions).toEqual({
      width: 1,
      trackOptions: { foregroundColor: "#003054", backgroundColor: "#000000" },
    });
    const button = nodesOfType(tree, "referenceBox")[0];
    expect(nodesOfType(button?.children ?? null, "text")[0]?.props.fg).toBe(
      focus === "retry:e1" ? "#1e1e1e" : "#e0e0e0",
    );
    expect(
      nodesOfType(tree, "text").find((node) => renderedText(node.children) === "Resume")?.props,
    ).toMatchObject({ fg: "#8a7144", attributes: 1 });
  },
);
it.each([
  [14, "worker 12s"],
  [21, "worker 12s    one"],
  [25, "worker 12s    one two"],
  [31, "worker 12s    one two three"],
  [40, "worker 12s    one two three    model"],
  [42, "worker 12s    one two three    model ·"],
  [49, "worker 12s    one two three    model · branch"],
] as const)("fits the status at a captured word boundary (%s columns)", (columns, expected) => {
  const tree = StatusBar({
    columns,
    copy: { ...copy, hints: { ...copy.hints, ready: "one two three" } },
    status: {
      ...INITIAL_STATUS,
      activity: "tool",
      toolName: "worker",
      elapsedMs: 12000,
      hint: "ready",
      model: "model",
      branch: "branch",
    },
  });
  expect(renderedText(tree)).toBe(expected);
  expect(nodesOfType(tree, "text")[0]?.props.width).toBe(columns - 4);
});
it.each([null, 0])("fits context without elapsed text or a hint (%s)", (elapsedMs) => {
  const status = {
    ...INITIAL_STATUS,
    activity: "tool" as const,
    toolName: "worker",
    elapsedMs,
    hint: "none" as const,
    model: "model",
    branch: "branch",
  };
  expect(renderedText(StatusBar({ columns: 20, copy, status }))).toBe("worker    model");
  expect(renderedText(StatusBar({ columns: 28, copy, status }))).toBe("worker    model · branch");
});
it("keeps context hidden when a long hint word cannot fit", () => {
  const tree = StatusBar({
    columns: 25,
    copy: { ...copy, hints: { ...copy.hints, ready: "one extraordinarilylong" } },
    status: {
      ...INITIAL_STATUS,
      activity: "tool",
      toolName: "worker",
      elapsedMs: null,
      hint: "ready",
      model: "m",
    },
  });
  expect(renderedText(tree)).toBe("worker    one");
});
