import { describe, expect, it, vi } from "vitest";

import {
  nodesOfType,
  renderedText,
  textLines,
} from "../../../test-support/element-tree.boundary.js";
import { PARITY_TEST_COPY } from "../../../test-support/parity-copy.js";
import { openApproval } from "../../parity/approval.js";
import type { SessionContext } from "../../parity/events.js";
import { openQuestions } from "../../parity/questions.js";
import { openSession, type SessionState } from "../../parity/session-state.js";
import { GEOMETRY, PALETTE } from "../../parity/tokens.js";
import type { Transcript } from "../../parity/transcript.js";
import { CommandSuggestions, COMPOSER_KEYS, Composer } from "./composer.js";
import { Conversation } from "./conversation.js";
import { ParityScreen } from "./parity-screen.js";

const copy = PARITY_TEST_COPY;
const style = {} as never;

const CONTEXT: SessionContext = {
  branch: "main",
  cwd: "/proyecto",
  model: "m",
  repositoryUrl: "",
};

function screen(session: SessionState, draft = "") {
  return ParityScreen({
    columns: 100,
    copy,
    draft,
    editor: null,
    focusedToolId: null,
    markdownStyle: style,
    onApproval: vi.fn(),
    onContentChange: vi.fn(),
    onQuestions: vi.fn(),
    onSubmit: vi.fn(),
    session,
  });
}

describe("command suggestions", () => {
  it("shows nothing at all while the draft is not a command", () => {
    expect(CommandSuggestions({ copy: copy.commands, text: "hola" })).toBeNull();
  });

  it("lists the matching commands with their descriptions", () => {
    const rendered = CommandSuggestions({ copy: copy.commands, text: "/" });
    expect(renderedText(rendered)).toBe(
      `/exit  ${copy.commands.exit}   /help  ${copy.commands.help}   /language  ${copy.commands.language}\n/retry  ${copy.commands.retry}   /details  ${copy.commands.details}`,
    );
    expect(nodesOfType(rendered, "box")[0]?.props.borderColor).toBe(PALETTE.accent);
  });
});

describe("composer", () => {
  it("binds Enter to sending and a modified Enter to a new line", () => {
    const describeBinding = (binding: (typeof COMPOSER_KEYS)[number]) =>
      `${binding.ctrl === true ? "ctrl+" : ""}${binding.shift === true ? "shift+" : ""}${binding.name}=${binding.action}`;
    expect(COMPOSER_KEYS.map(describeBinding)).toEqual([
      "return=submit",
      "enter=submit",
      "shift+return=newline",
      "shift+enter=newline",
      "ctrl+j=newline",
      "home=visual-line-home",
      "end=visual-line-end",
      "shift+home=select-visual-line-home",
      "shift+end=select-visual-line-end",
      "ctrl+shift+left=select-word-backward",
      "ctrl+shift+right=select-word-forward",
      "ctrl+z=undo",
      "ctrl+y=redo",
      "ctrl+shift+k=delete-line",
      "f7=select-all",
      "ctrl+a=visual-line-home",
      "ctrl+e=visual-line-end",
    ]);
  });

  it("grows between three and twelve rows and keeps the accent rule when ready", () => {
    const rendered = Composer({
      canSubmit: true,
      disabled: false,
      editor: null,
      onContentChange: vi.fn(),
      onSubmit: vi.fn(),
      placeholder: copy.composerPlaceholder,
    });
    expect(nodesOfType(rendered, "referenceBox")[0]?.props).toMatchObject({
      borderColor: PALETTE.accent,
      maxHeight: GEOMETRY.composerMaxRows,
      minHeight: GEOMETRY.composerMinRows,
    });
    expect(nodesOfType(rendered, "textarea")[0]?.props).toMatchObject({
      focused: true,
      keyBindings: [...COMPOSER_KEYS],
      placeholder: copy.composerPlaceholder,
    });
  });

  it("quiets the rule while a turn runs, without taking the keyboard away", () => {
    const rendered = Composer({
      canSubmit: false,
      disabled: false,
      editor: null,
      onContentChange: vi.fn(),
      onSubmit: vi.fn(),
      placeholder: copy.composerPlaceholder,
    });
    expect(nodesOfType(rendered, "referenceBox")[0]?.props.borderColor).toBe(PALETTE.panel);
    expect(nodesOfType(rendered, "textarea")[0]?.props.focused).toBe(true);
  });

  it("gives up the focus when it is disabled", () => {
    const rendered = Composer({
      canSubmit: true,
      disabled: true,
      editor: null,
      onContentChange: vi.fn(),
      onSubmit: vi.fn(),
      placeholder: copy.composerPlaceholder,
    });
    expect(nodesOfType(rendered, "textarea")[0]?.props.focused).toBe(false);
    expect(nodesOfType(rendered, "referenceBox")[0]?.props.borderColor).toBe(PALETTE.panel);
  });
});

function conversation(transcript: Transcript, focusedToolId: string | null = null) {
  return Conversation({
    columns: 100,
    copy,
    focusedToolId,
    markdownStyle: style,
    onApproval: vi.fn(),
    onQuestions: vi.fn(),
    transcript,
  });
}

describe("conversation", () => {
  it("marks the student's own message and streams the answer as Markdown", () => {
    const rendered = conversation([
      { id: "e0", kind: "user", text: "hola" },
      { id: "e1", kind: "assistant", streaming: true, text: "## Hola" },
    ]);
    expect(renderedText(rendered)).toContain("> hola");
    expect(nodesOfType(rendered, "referenceMarkdown")[0]?.props).toMatchObject({
      content: "## Hola",
      streaming: true,
    });
  });

  it("shows the banner, a reasoning note and a plain notice", () => {
    const rendered = conversation([
      { context: CONTEXT, id: "e0", kind: "banner" },
      { id: "e1", kind: "reasoning", text: "  voy a mirarlo  " },
      { id: "e2", kind: "notice", text: copy.turn.interrupted, tone: "plain" },
    ]);
    const lines = textLines(rendered);
    expect(lines).toContain("voy a mirarlo");
    expect(lines).toContain(copy.turn.interrupted);
    expect(lines.some((line) => line.includes("█"))).toBe(true);
  });

  it("renders the help as Markdown rather than as a line", () => {
    const rendered = conversation([{ id: "e0", kind: "notice", text: copy.help, tone: "help" }]);
    expect(nodesOfType(rendered, "referenceMarkdown")[0]?.props.content).toBe(copy.help);
  });

  it("shows a tool row, an approval and a question set", () => {
    const rendered = conversation([
      {
        id: "e0",
        kind: "tool",
        row: {
          call: { arguments: {}, callId: "c1", name: "execute" },
          expanded: false,
          outcome: null,
        },
      },
      {
        approval: openApproval({
          arguments: {},
          interruptId: "i1",
          name: "execute",
          preview: "pytest",
          warnings: [],
        }),
        id: "e1",
        kind: "approval",
      },
      {
        id: "e2",
        kind: "questions",
        questions: openQuestions({
          interruptId: "q1",
          questions: [{ choices: [], required: true, text: "¿cuál?" }],
        }),
      },
    ]);
    const lines = textLines(rendered);
    expect(lines[0]).toBe("● shell");
    expect(lines).toContain("Autorizar · execute");
    expect(lines).toContain(copy.question.title);
  });

  it("offers a retry on a retryable failure and shows it spent afterwards", () => {
    const live = conversation([
      {
        detail: "Puedes reanudarlo.",
        id: "e0",
        kind: "error",
        message: "falló",
        retryOffered: true,
        retryable: true,
      },
    ]);
    expect(textLines(live)).toEqual(["falló", "Puedes reanudarlo.", copy.turn.retry]);
    const spent = conversation([
      {
        detail: "",
        id: "e0",
        kind: "error",
        message: "falló",
        retryOffered: false,
        retryable: true,
      },
    ]);
    expect(textLines(spent)).toEqual(["falló", copy.turn.retryStarted]);
  });

  it("offers nothing on a failure with no checkpoint", () => {
    const rendered = conversation([
      {
        detail: "",
        id: "e0",
        kind: "error",
        message: "falló",
        retryOffered: false,
        retryable: false,
      },
    ]);
    expect(textLines(rendered)).toEqual(["falló"]);
  });

  it("gives every entry its own key", () => {
    const rendered = conversation([
      { id: "e0", kind: "user", text: "uno" },
      { id: "e1", kind: "user", text: "dos" },
    ]);
    expect(nodesOfType(rendered, "box").map((node) => node.key)).toEqual(["e0", "e1"]);
  });

  it("lifts the focused tool row and leaves the others alone", () => {
    const transcript: Transcript = [
      {
        id: "e0",
        kind: "tool",
        row: {
          call: { arguments: {}, callId: "c1", name: "execute" },
          expanded: false,
          outcome: { failed: false, result: "ok" },
        },
      },
    ];
    expect(
      nodesOfType(conversation(transcript, "e0"), "box").find(
        (node) => node.props.backgroundColor !== undefined,
      )?.props.backgroundColor,
    ).toBe(PALETTE.surface);
    expect(
      nodesOfType(conversation(transcript, "e9"), "box").find(
        (node) => node.props.backgroundColor !== undefined,
      )?.props.backgroundColor,
    ).toBe(PALETTE.background);
    expect(
      nodesOfType(conversation(transcript), "box").find(
        (node) => node.props.backgroundColor !== undefined,
      )?.props.backgroundColor,
    ).toBe(PALETTE.background);
  });
});

describe("screen", () => {
  it("says it is preparing, with nothing to read and no way to type", () => {
    const rendered = screen(openSession());
    expect(textLines(rendered)).toContain(copy.preparing);
    expect(nodesOfType(rendered, "referenceConversation")).toHaveLength(0);
    expect(nodesOfType(rendered, "textarea")[0]?.props.focused).toBe(false);
  });

  it("shows the conversation and the bar once the session is running", () => {
    const session: SessionState = {
      ...openSession(),
      starting: false,
      transcript: [{ id: "e0", kind: "user", text: "hola" }],
      turnActive: false,
    };
    const rendered = screen(session);
    expect(renderedText(rendered)).toContain("> hola");
    expect(renderedText(rendered)).toContain(copy.status.starting);
    expect(nodesOfType(rendered, "textarea")[0]?.props.focused).toBe(true);
  });

  it("keeps the composer rule quiet while a turn runs and bright when it is over", () => {
    const base = { ...openSession(), starting: false };
    const composerOf = (session: SessionState) =>
      nodesOfType(screen(session), "textarea")[0]?.props.borderColor ??
      nodesOfType(screen(session), "referenceBox")[0]?.props.borderColor;
    expect(composerOf({ ...base, turnActive: true })).toBe(PALETTE.panel);
    expect(composerOf({ ...base, turnActive: false })).toBe(PALETTE.accent);
  });

  it("opens the suggestion strip from the draft it is given", () => {
    expect(
      nodesOfType(screen(openSession(), "/re"), "text").some((node) =>
        renderedText(node.children).includes("/retry"),
      ),
    ).toBe(true);
    expect(
      nodesOfType(screen(openSession(), "hola"), "text").some((node) =>
        renderedText(node.children).includes("/retry"),
      ),
    ).toBe(false);
  });

  it("takes the composer away while a decision is pending and after a fatal error", () => {
    const base = { ...openSession(), starting: false };
    const pending: SessionState = { ...base, pendingId: "e1" };
    expect(nodesOfType(screen(pending), "textarea")[0]?.props.focused).toBe(false);
    expect(nodesOfType(screen({ ...base, fatal: true }), "textarea")[0]?.props.focused).toBe(false);
    expect(nodesOfType(screen(base), "textarea")[0]?.props.focused).toBe(true);
  });

  it("sits on the conversation background", () => {
    expect(nodesOfType(screen(openSession()), "box")[0]?.props.backgroundColor).toBe(
      PALETTE.background,
    );
  });
});
