import { expect, it, vi } from "vitest";
import { PARITY_TEST_COPY as copy } from "../../../test-support/parity-copy.js";
import { flatten, nodesOfType } from "../../../test-support/element-tree.boundary.js";
import { openApproval } from "../../parity/approval.js";
import { openQuestions } from "../../parity/questions.js";
import { applyEvent, openSession } from "../../parity/session-state.js";
import { ApprovalPanel } from "./approval-panel.js";
import { QuestionsPanel } from "./questions-panel.js";
import { ParityScreen } from "./parity-screen.js";
import { Conversation } from "./conversation.js";
import type { ParityInteraction } from "./interaction.js";
import { Composer } from "./composer.js";
import { ToolRowView } from "./tool-row.js";
import { InlinePanel } from "./panel.js";
import { PALETTE } from "../../parity/tokens.js";
import type { ReactNode } from "react";

function clicks(rendered: ReactNode) {
  for (const node of flatten(rendered)) {
    if (typeof node.props.onMouseDown === "function")
      (node.props.onMouseDown as (event: { button: number; x: number; y: number }) => void)({
        button: 0,
        x: 2,
        y: 3,
      });
    if (typeof node.props.onMouseUp === "function")
      (node.props.onMouseUp as (event: { button: number; x: number; y: number }) => void)({
        button: 0,
        x: 2,
        y: 3,
      });
  }
}
const interaction = (focus: string) =>
  ({
    focus,
    scroll: null,
    activate: vi.fn(),
    focusOn: vi.fn(),
  }) satisfies ParityInteraction;

it("makes pending panels' actions and input focus reachable without changing resolved panels", () => {
  const onAction = vi.fn();
  const state = openApproval({
    interruptId: "a",
    name: "write_file",
    preview: "Short",
    arguments: { content: "Full", filePath: "file" },
    warnings: [],
  });
  for (const focus of ["preview", "approve", "reject"]) {
    const controls = interaction(focus);
    const rendered = ApprovalPanel({
      id: "a",
      copy: copy.approval,
      state,
      onAction,
      interaction: controls,
    });
    expect(nodesOfType(rendered, "box")[0]?.props.id).toBe("a");
    expect(nodesOfType(rendered, "referenceScrollbox")[0]?.props.border).toEqual(
      focus === "preview" ? ["left"] : [],
    );
    const buttons = nodesOfType(rendered, "referenceBox").filter(
      (node) => node.props.referenceBorder === "button",
    );
    expect(buttons.map((node) => node.props.borderColor)).toEqual([
      PALETTE.buttonApproveEdge,
      PALETTE.buttonRejectEdge,
    ]);
    clicks(rendered);
  }
  for (const focus of ["reason", "preview"]) {
    const controls = interaction(focus);
    const rendered = ApprovalPanel({
      copy: copy.approval,
      state: { ...state, stage: "rejecting" },
      onAction,
      interaction: controls,
    });
    expect(nodesOfType(rendered, "input")[0]?.props.focused).toBe(focus === "reason");
    clicks(rendered);
    expect(controls.focusOn).toHaveBeenCalledWith("reason");
  }
  const questions = openQuestions({
    interruptId: "q",
    questions: [{ text: "One", choices: [], required: false }],
  });
  for (const focus of ["answer", "previous", "next"]) {
    const controls = interaction(focus);
    const rendered = QuestionsPanel({
      id: "q",
      copy: copy.question,
      state: questions,
      onAction,
      interaction: controls,
    });
    expect(nodesOfType(rendered, "input")[0]?.props.focused).toBe(focus === "answer");
    expect(
      nodesOfType(rendered, "referenceBox")
        .filter((node) => node.props.referenceBorder === "button")
        .map((node) => node.props.borderColor),
    ).toEqual([PALETTE.buttonDisabledEdge, PALETTE.buttonPrimaryEdge]);
    clicks(rendered);
    expect(controls.focusOn).toHaveBeenCalledWith("answer");
  }
  clicks(ApprovalPanel({ copy: copy.approval, state: { ...state, stage: "rejecting" }, onAction }));
  clicks(QuestionsPanel({ copy: copy.question, state: questions, onAction }));
});

it("connects tool and retry activation and composer focus through the complete screen", () => {
  let session = applyEvent(openSession(), {
    type: "session-started",
    context: { cwd: "/p", branch: "", model: "", repositoryUrl: "" },
  });
  session = applyEvent(session, { type: "tool-started", callId: "t", name: "read", arguments: {} });
  session = applyEvent(session, {
    type: "tool-finished",
    callId: "t",
    result: "Done",
    failed: false,
  });
  session = applyEvent(session, {
    type: "turn-failed",
    detail: "",
    message: "Error",
    recoverable: true,
    retryable: true,
  });
  for (const focus of ["composer", "tool:e1", "retry:e2"]) {
    const controls = interaction(focus);
    const rendered = ParityScreen({
      columns: 80,
      copy,
      draft: "",
      editor: null,
      markdownStyle: {} as never,
      focusedToolId: null,
      onApproval: vi.fn(),
      onQuestions: vi.fn(),
      onContentChange: vi.fn(),
      onSubmit: vi.fn(),
      session,
      interaction: controls,
    });
    expect(nodesOfType(rendered, "textarea")[0]?.props.focused).toBe(focus === "composer");
    expect(nodesOfType(rendered, "referenceConversation")[0]?.props.ref).toBeNull();
    const boxes = nodesOfType(rendered, "box");
    expect(boxes.find((node) => node.props.id === "e1")?.props.backgroundColor).toBe(
      focus === "tool:e1" ? PALETTE.surface : PALETTE.background,
    );
    expect(
      nodesOfType(rendered, "referenceBox")
        .filter((node) => node.props.referenceBorder === "button")
        .map((node) => node.props.borderColor),
    ).toEqual([PALETTE.buttonDefaultEdge]);
    clicks(rendered);
    expect(controls.focusOn).toHaveBeenCalledWith("composer");
    expect(controls.activate).toHaveBeenCalledWith("tool:e1");
  }
  const controls = interaction("retry:e2");
  const props = {
    columns: 80,
    copy,
    focusedToolId: null,
    markdownStyle: {} as never,
    onApproval: vi.fn(),
    onQuestions: vi.fn(),
    transcript: session.transcript,
  };
  clicks(Conversation({ ...props, interaction: controls }));
  expect(controls.activate).toHaveBeenCalledWith("tool:e1");
  expect(controls.activate).toHaveBeenCalledWith("retry:e2");
  clicks(Conversation(props));
  const resolved = session.transcript.map((entry) =>
    entry.kind === "error" ? { ...entry, retryOffered: false } : entry,
  );
  const dormant = interaction("");
  clicks(Conversation({ ...props, transcript: resolved, interaction: dormant }));
  expect(dormant.activate).not.toHaveBeenCalledWith("retry:e2");
});

it("passes focus to the pending question and approval in the transcript", () => {
  for (const event of [
    {
      type: "approval-requested" as const,
      request: { interruptId: "a", name: "write_file", arguments: {}, preview: "", warnings: [] },
    },
    {
      type: "questions-asked" as const,
      request: { interruptId: "q", questions: [{ text: "Why", choices: [], required: false }] },
    },
  ]) {
    const session = applyEvent(openSession(), event);
    const rendered = Conversation({
      columns: 80,
      copy,
      focusedToolId: null,
      markdownStyle: {} as never,
      onApproval: vi.fn(),
      onQuestions: vi.fn(),
      transcript: session.transcript,
      interaction: interaction(event.type === "approval-requested" ? "reject" : "previous"),
    });
    expect(nodesOfType(rendered, "box")[0]?.props.id).toBe("e0");
    expect(
      nodesOfType(rendered, "referenceBox")
        .filter((node) => node.props.referenceBorder === "button")
        .map((node) => node.props.borderColor),
    ).toEqual(
      event.type === "approval-requested"
        ? [PALETTE.buttonApproveEdge, PALETTE.buttonRejectEdge]
        : [PALETTE.buttonDisabledEdge, PALETTE.buttonPrimaryEdge],
    );
  }
});

it("passes stable native ids and leaves optional event handlers harmless", () => {
  const row = {
    call: { callId: "t", name: "read", arguments: {} },
    expanded: false,
    outcome: { failed: false, result: "done" },
  };
  const toggle = vi.fn();
  const tool = ToolRowView({
    copy: copy.tool,
    focused: false,
    row,
    id: "tool-anchor",
    onToggle: toggle,
  });
  expect(nodesOfType(tool, "box")[0]?.props.id).toBe("tool-anchor");
  clicks(tool);
  expect(toggle).toHaveBeenCalledOnce();
  const noId = ToolRowView({ copy: copy.tool, focused: false, row });
  expect(nodesOfType(noId, "box")[0]?.props).not.toHaveProperty("id");
  clicks(noId);
  expect(
    nodesOfType(InlinePanel({ children: null, resolved: false }), "box")[0]?.props,
  ).not.toHaveProperty("id");
  clicks(
    Composer({
      canSubmit: true,
      disabled: false,
      editor: null,
      onContentChange: vi.fn(),
      onSubmit: vi.fn(),
      placeholder: "Type",
    }),
  );
});
