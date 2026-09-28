import type { ReactNode } from "react";
import { ReferenceInput } from "./reference-controls.js";
import { describe, expect, it, vi } from "vitest";

import {
  nodesOfType,
  renderedText,
  textLines,
} from "../../../test-support/element-tree.boundary.js";
import { PARITY_TEST_COPY } from "../../../test-support/parity-copy.js";
import {
  approvalReducer,
  openApproval,
  type ApprovalAction,
  type ApprovalRequest,
} from "../../parity/approval.js";
import {
  openQuestions,
  questionsReducer,
  type QuestionsAction,
  type QuestionsRequest,
} from "../../parity/questions.js";
import { PALETTE } from "../../parity/tokens.js";
import { ApprovalPanel } from "./approval-panel.js";
import { QuestionsPanel } from "./questions-panel.js";

const approvalCopy = PARITY_TEST_COPY.approval;
const questionCopy = PARITY_TEST_COPY.question;

const WRITE: ApprovalRequest = {
  arguments: { content: "def media():\n    return 0\n", filePath: "media.py" },
  interruptId: "i1",
  name: "write_file",
  preview: "media.py  (3 línea(s))",
  warnings: ["El comando sale de la carpeta del proyecto."],
};

const SHELL: ApprovalRequest = {
  arguments: {},
  interruptId: "i2",
  name: "execute",
  preview: "pytest -q",
  warnings: [],
};

function approval(request: ApprovalRequest, ...actions: readonly ApprovalAction[]) {
  const onAction = vi.fn<(action: ApprovalAction) => void>();
  const state = actions.reduce(approvalReducer, openApproval(request));
  return { onAction, rendered: ApprovalPanel({ copy: approvalCopy, onAction, state }), state };
}

describe("approval panel", () => {
  it("names the operation, previews it and warns", () => {
    const { rendered } = approval(WRITE);
    const lines = textLines(rendered);
    expect(lines[0]).toBe("Autorizar · write_file");
    expect(lines).toContain("⚠ El comando sale de la carpeta del proyecto.");
    expect(renderedText(nodesOfType(rendered, "referenceScrollbox")[0]?.children ?? null)).toBe(
      WRITE.preview + approvalCopy.expand,
    );
    expect(nodesOfType(rendered, "box")[0]?.props.borderColor).toBe(PALETTE.warning);
  });

  it("offers to show everything, and shows it once asked", () => {
    const { onAction, rendered } = approval(WRITE);
    expect(textLines(rendered)).toContain(approvalCopy.expand);
    const toggle = nodesOfType(rendered, "text").find(
      (node) => typeof node.props.onMouseDown === "function",
    );
    clickButton(toggle);
    expect(onAction).toHaveBeenCalledWith({ type: "toggle-preview" });

    const opened = approval(WRITE, { type: "toggle-preview" });
    expect(textLines(opened.rendered)).toContain(approvalCopy.collapse);
    expect(
      renderedText(nodesOfType(opened.rendered, "referenceScrollbox")[0]?.children ?? null),
    ).toContain("def media()");
  });

  it("offers no toggle when the preview already says everything", () => {
    const { rendered } = approval(SHELL);
    expect(textLines(rendered)).not.toContain(approvalCopy.expand);
    expect(
      nodesOfType(rendered, "text").filter((node) => typeof node.props.onMouseDown === "function"),
    ).toHaveLength(0);
  });

  it("reports an authorization and a rejection from the buttons", () => {
    const { onAction, rendered } = approval(SHELL);
    const buttons = nodesOfType(rendered, "referenceBox").filter(
      (node) => typeof node.props.onMouseDown === "function",
    );
    expect(buttons).toHaveLength(2);
    clickButton(buttons[0]);
    clickButton(buttons[1]);
    expect(onAction.mock.calls).toEqual([[{ type: "approve" }], [{ type: "start-reject" }]]);
  });

  it("asks for a reason only after rejecting, and confirms it from the field", () => {
    expect(nodesOfType(approval(SHELL).rendered, "input")).toHaveLength(0);
    const { onAction, rendered } = approval(SHELL, { type: "start-reject" });
    const [field] = nodesOfType(rendered, "input");
    expect(field?.props).toMatchObject({
      focused: true,
      placeholder: approvalCopy.reasonPlaceholder,
    });
    (field?.props.onInput as (value: string) => void)("lo hago yo");
    (field?.props.onSubmit as () => void)();
    expect(onAction.mock.calls).toEqual([
      [{ reason: "lo hago yo", type: "set-reason" }],
      [{ type: "confirm-reject" }],
    ]);
  });

  it("reserves the reference outcome row while still deciding", () => {
    expect(textLines(approval(SHELL).rendered)).toEqual([
      "Autorizar · execute",
      SHELL.preview,
      `${approvalCopy.approve} `,
      `${approvalCopy.reject} `,
      "",
    ]);
  });

  it("keeps the outcome on screen, with the actions gone and the rule quiet", () => {
    const { rendered } = approval(SHELL, { type: "approve" });
    expect(textLines(rendered)).toEqual([
      "Autorizar · execute",
      SHELL.preview,
      approvalCopy.approved,
    ]);
    expectQuietPanel(rendered);
  });

  it("shows no preview box when the operation has no preview at all", () => {
    const { rendered } = approval({ ...SHELL, preview: "" });
    expect(nodesOfType(rendered, "referenceScrollbox")).toHaveLength(0);
  });
});

const REQUEST: QuestionsRequest = {
  interruptId: "q1",
  questions: [
    { choices: ["0", "None", "Un error"], required: true, text: "¿Qué debe devolver?" },
    { choices: [], required: false, text: "¿Por qué?" },
  ],
};

function questions(...actions: readonly QuestionsAction[]) {
  const onAction = vi.fn<(action: QuestionsAction) => void>();
  const state = actions.reduce(questionsReducer, openQuestions(REQUEST));
  return { onAction, rendered: QuestionsPanel({ copy: questionCopy, onAction, state }), state };
}

describe("questions panel", () => {
  it("shows the title, the progress, the question and its choices, and nothing else", () => {
    expect(textLines(questions().rendered)).toEqual([
      questionCopy.title,
      "Pregunta 1 de 2",
      "¿Qué debe devolver? *",
      "   1) 0",
      "   2) None",
      "   3) Un error",
      "",
      questionCopy.previous,
      questionCopy.next,
      "",
    ]);
  });

  it("marks an optional question without a star and shows no choices", () => {
    const { rendered } = questions({ type: "type", value: "1" }, { type: "next" });
    expect(textLines(rendered)).toEqual([
      questionCopy.title,
      "Pregunta 2 de 2",
      "¿Por qué?",
      "",
      questionCopy.previous,
      questionCopy.send,
      "",
    ]);
    expect(nodesOfType(questions().rendered, "box").length).toBeGreaterThan(
      nodesOfType(rendered, "box").length,
    );
  });

  it("takes an answer and advances with Enter", () => {
    const { onAction, rendered } = questions();
    const [field] = nodesOfType(rendered, "input");
    expect(field?.props).toMatchObject({
      focused: true,
      placeholder: questionCopy.placeholder,
      value: "",
    });
    (field?.props.onInput as (value: string) => void)("2");
    (field?.props.onSubmit as () => void)();
    expect(onAction.mock.calls).toEqual([[{ type: "type", value: "2" }], [{ type: "next" }]]);
  });

  it("sends with Enter on the last question", () => {
    const { onAction, rendered } = questions({ type: "type", value: "1" }, { type: "next" });
    (nodesOfType(rendered, "input")[0]?.props.onSubmit as () => void)();
    expect(onAction).toHaveBeenCalledWith({ type: "submit" });
  });

  it("offers Siguiente first and Enviar respuestas on the last question", () => {
    expect(textLines(questions().rendered)).toContain(questionCopy.next);
    const last = questions({ type: "type", value: "1" }, { type: "next" });
    expect(textLines(last.rendered)).toContain(questionCopy.send);
    const buttons = nodesOfType(last.rendered, "referenceBox").filter(
      (node) => typeof node.props.onMouseDown === "function",
    );
    clickButton(buttons[1]);
    expect(last.onAction).toHaveBeenCalledWith({ type: "submit" });
  });

  it("moves back and forward from the buttons", () => {
    const { onAction, rendered } = questions();
    const buttons = nodesOfType(rendered, "referenceBox").filter(
      (node) => typeof node.props.onMouseDown === "function",
    );
    clickButton(buttons[0]);
    clickButton(buttons[1]);
    expect(onAction.mock.calls).toEqual([[{ type: "next" }]]);
  });

  it("dims the way back on the first question", () => {
    const first = nodesOfType(questions().rendered, "text").find(
      (node) => renderedText(node.children) === questionCopy.previous,
    );
    expect(first?.props.fg).toBe(PALETTE.buttonDisabledText);
    const second = questions({ type: "type", value: "1" }, { type: "next" });
    const back = nodesOfType(second.rendered, "text").find(
      (node) => renderedText(node.children) === questionCopy.previous,
    );
    expect(back?.props.fg).toBe(PALETTE.text);
  });

  it("says a required question is required, and says nothing when it is answered", () => {
    expect(textLines(questions({ type: "submit" }).rendered)).toContain(questionCopy.required);
    expect(textLines(questions().rendered)).not.toContain(questionCopy.required);
  });

  it("keeps the outcome, with the navigation gone and the rule quiet", () => {
    const { rendered } = questions(
      { type: "type", value: "1" },
      { type: "next" },
      { type: "submit" },
    );
    expect(textLines(rendered)).toEqual([
      questionCopy.title,
      "Pregunta 2 de 2",
      "¿Por qué?",
      questionCopy.placeholder,
      questionCopy.sent,
    ]);
    expectQuietPanel(rendered);
    expect(nodesOfType(rendered, "input")).toHaveLength(0);
  });
});

it("returns from a later question and preserves a submitted answer without an editable field", () => {
  const onAction = vi.fn();
  let state = openQuestions({
    interruptId: "q",
    questions: [
      { text: "First", choices: [], required: false },
      { text: "Second", choices: [], required: false },
    ],
  });
  state = { ...state, index: 1, answers: new Map([[1, "saved"]]) };
  const view = QuestionsPanel({ copy: questionCopy, state, onAction });
  const previous = nodesOfType(view, "referenceBox").find(
    (node) => renderedText(node.children) === questionCopy.previous,
  );
  const event = { button: 0, x: 2, y: 3 };
  (previous?.props.onMouseDown as (press: { button: number; x: number; y: number }) => void)(event);
  (previous?.props.onMouseUp as (press: { button: number; x: number; y: number }) => void)(event);
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: "previous" });
  const resolved = QuestionsPanel({
    copy: questionCopy,
    state: { ...state, resolved: true },
    onAction,
  });
  expect(nodesOfType(resolved, "input")).toHaveLength(0);
  expect(renderedText(resolved)).toContain("saved");
});

it("shows the placeholder in a read-only input with no saved value", () => {
  const rendered = ReferenceInput({ readOnly: true, placeholder: "No answer" });
  expect(renderedText(rendered)).toBe("No answer");
  expect(nodesOfType(rendered, "input")).toHaveLength(0);
});

function clickButton(button: ReturnType<typeof nodesOfType>[number] | undefined): void {
  const event = { button: 0, x: 2, y: 3 };
  for (const name of ["onMouseDown", "onMouseUp"]) {
    (button?.props[name] as (pointer: typeof event) => void)(event);
  }
}

it.each([true, false])(
  "fills the whole input row while preserving panel borders (%s)",
  (readOnly) => {
    const tree = ReferenceInput({ readOnly });
    expect(nodesOfType(tree, "referenceBox")[0]?.props.backgroundColor).toBe("#1e1e1e");
    expect(nodesOfType(tree, "box")[0]?.props).toMatchObject({
      height: 1,
      width: "100%",
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: readOnly ? "#1e1e1e" : "#272727",
    });
  },
);

function expectQuietPanel(tree: ReactNode): void {
  const buttons = nodesOfType(tree, "referenceBox").filter(
    (node) => typeof node.props.onMouseDown === "function",
  );
  expect(buttons).toHaveLength(0);
  expect(nodesOfType(tree, "box")[0]?.props.borderColor).toBe(PALETTE.panel);
}
