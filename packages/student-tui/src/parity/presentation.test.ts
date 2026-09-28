import { expect, it, vi } from "vitest";

import { PARITY_TEST_COPY } from "../../test-support/parity-copy.js";
import { nodesOfType, renderedText } from "../../test-support/element-tree.boundary.js";
import type { ConversationSnapshot } from "../conversation-contracts.js";
import { ParityScreen } from "../platform/parity/parity-screen.js";
import { createPresentation } from "./presentation.js";

const copy = PARITY_TEST_COPY;
const context = { branch: "main", cwd: "/project", model: "", repositoryUrl: "" };
const ready: ConversationSnapshot = { messages: [], approval: null, status: "ready" };

it("maps controller snapshots to the parity screen and keeps a resolved approval", () => {
  const dispatch = vi.fn();
  const presentation = createPresentation(context, copy, dispatch);
  presentation.sync(ready);
  expect(presentation.submit("Write notes")).toBe(true);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "submit", text: "Write notes" });
  const pending: ConversationSnapshot = {
    status: "approval",
    messages: [
      { author: "student", text: "Write notes" },
      { author: "marea", text: "Checking" },
    ],
    approval: {
      approvalId: "approval:1",
      content: "Exact contents",
      path: "notes.txt",
      summary: "Create notes",
    },
  };
  presentation.sync(pending);
  presentation.sync(pending);
  presentation.approve({ type: "toggle-preview" });
  const screen = ParityScreen({
    columns: 80,
    copy,
    draft: "kept draft",
    editor: null,
    focusedToolId: null,
    markdownStyle: {} as never,
    onApproval: (action) => {
      presentation.approve(action);
    },
    onContentChange: vi.fn(),
    onQuestions: vi.fn(),
    onSubmit: vi.fn(),
    session: presentation.snapshot(),
  });
  expect(renderedText(screen)).toContain("Exact contents");
  expect(nodesOfType(screen, "textarea")[0]?.props.focused).toBe(false);
  expect(presentation.snapshot().transcript.map((entry) => entry.kind)).toEqual([
    "banner",
    "user",
    "assistant",
    "approval",
  ]);
  presentation.approve({ type: "approve" });
  presentation.approve({ type: "approve" });
  expect(dispatch.mock.calls).toEqual([
    [{ type: "submit", text: "Write notes" }],
    [{ type: "approve", interruptId: "approval:1" }],
  ]);
  presentation.sync({
    ...pending,
    approval: null,
    status: "ready",
    messages: [
      { author: "student", text: "Write notes" },
      { author: "marea", text: "Checking Done" },
    ],
  });
  expect(presentation.snapshot()).toMatchObject({
    turnActive: false,
    pendingId: null,
    status: { activity: "ready" },
  });
  expect(presentation.snapshot().transcript.at(-1)).toMatchObject({
    kind: "assistant",
    text: " Done",
    streaming: false,
  });
  expect(presentation.snapshot().transcript[3]).toMatchObject({
    kind: "approval",
    approval: { decision: { type: "approve" } },
  });
});

it("keeps local commands out of the model and preserves busy drafts", () => {
  const dispatch = vi.fn();
  const presentation = createPresentation(context, copy, dispatch);
  expect(presentation.submit("draft")).toBe(false);
  presentation.sync(ready);
  for (const text of ["", "  ", "a".repeat(8193)]) expect(presentation.submit(text)).toBe(false);
  for (const text of ["/help", "/details", "/details", "/retry"])
    expect(presentation.submit(text)).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  presentation.sync({
    ...ready,
    status: "failed",
    failure: {
      kind: "unexpected",
      detail: "",
      recoverable: true,
      retryable: true,
      hasPrefix: false,
    },
  });
  expect(presentation.submit("/retry")).toBe(true);
  expect(presentation.submit("/salir")).toBe(true);
  expect(dispatch.mock.calls).toEqual([[{ type: "retry" }], [{ type: "exit" }]]);
});

it("cancels the pending approval when the controller cancels and ignores late actions", () => {
  const dispatch = vi.fn();
  const presentation = createPresentation(context, copy, dispatch);
  presentation.sync({
    ...ready,
    status: "approval",
    approval: { approvalId: "approval:1", path: "notes", summary: "Write" },
  });
  expect(presentation.snapshot().transcript.at(-1)).toMatchObject({
    approval: { request: { interruptId: "approval:1" } },
  });
  presentation.sync({ ...ready, status: "cancelled" });
  expect(presentation.snapshot().pendingId).toBeNull();
  expect(presentation.snapshot().transcript[1]).toMatchObject({
    approval: { decision: { type: "cancel" } },
  });
  expect(presentation.snapshot().transcript.at(-1)).toMatchObject({
    approval: { decision: { type: "cancel" } },
  });
  presentation.approve({ type: "approve" });
  expect(dispatch).not.toHaveBeenCalled();
});

it("dispatches rejection only on confirmation and cancellation only once", () => {
  const dispatch = vi.fn();
  const presentation = createPresentation(context, copy, dispatch);
  const pending: ConversationSnapshot = {
    ...ready,
    status: "approval",
    approval: { approvalId: "approval:1", path: "notes", summary: "Write" },
  };
  presentation.sync(pending);
  presentation.approve({ type: "start-reject" });
  presentation.approve({ type: "set-reason", reason: "Change the approach" });
  expect(dispatch).not.toHaveBeenCalled();
  presentation.approve({ type: "confirm-reject" });
  expect(dispatch.mock.calls).toEqual([
    [{ type: "reject", interruptId: "approval:1", reason: "Change the approach" }],
  ]);
  presentation.sync({ ...ready, status: "streaming" });
  presentation.sync({ ...pending, approval: { path: "other", summary: "Write other" } });
  presentation.approve({ type: "cancel" });
  expect(dispatch.mock.calls).toEqual([
    [{ type: "reject", interruptId: "approval:1", reason: "Change the approach" }],
    [{ type: "cancel" }],
  ]);
});

it("initializes from a nonempty first snapshot and assigns stable transcript identities", () => {
  const presentation = createPresentation(context, copy, vi.fn());
  presentation.sync({
    ...ready,
    messages: [
      { author: "student", text: "Hello" },
      { author: "marea", text: "Hi" },
    ],
    status: "streaming",
  });
  expect(presentation.snapshot()).toMatchObject({
    nextId: 3,
    turnActive: true,
    transcript: [
      { id: "e0", kind: "banner", context },
      { id: "e1", kind: "user", text: "Hello" },
      { id: "e2", kind: "assistant", text: "Hi", streaming: true },
    ],
  });
  presentation.submit("/help");
  presentation.submit("/details");
  presentation.submit("/details");
  presentation.submit("/retry");
  expect(presentation.snapshot()).toMatchObject({
    nextId: 7,
    detailedOutputs: false,
    transcript: [
      { id: "e0", kind: "banner" },
      { id: "e1", kind: "user" },
      { id: "e2", kind: "assistant", streaming: false },
      { id: "e3", kind: "notice", text: copy.help, tone: "help" },
      { id: "e4", kind: "notice", text: copy.notices.outputsDetailed, tone: "plain" },
      { id: "e5", kind: "notice", text: copy.notices.outputsCompact, tone: "plain" },
      { id: "e6", kind: "notice", text: copy.notices.noRetry, tone: "plain" },
    ],
  });
});

it("maps every approval field and preserves live text until completion", () => {
  const presentation = createPresentation(context, copy, vi.fn());
  presentation.sync({
    ...ready,
    status: "streaming",
    messages: [{ author: "marea", text: "Hello" }],
  });
  expect(presentation.snapshot()).toMatchObject({
    turnActive: true,
    status: { activity: "responding", elapsedMs: 0 },
  });
  const pending: ConversationSnapshot = {
    ...ready,
    status: "approval",
    approval: { approvalId: "review", content: "Body", path: "file", summary: "Summary" },
    messages: [{ author: "marea", text: "Hello world" }],
  };
  presentation.sync(pending);
  expect(presentation.snapshot()).toMatchObject({
    turnActive: true,
    pendingId: "e2",
    nextId: 3,
    transcript: [
      { kind: "banner" },
      { id: "e1", kind: "assistant", text: "Hello world", streaming: false },
      {
        id: "e2",
        kind: "approval",
        approval: {
          request: {
            interruptId: "review",
            name: "write_file",
            arguments: { content: "Body", filePath: "file" },
            preview: "Summary\nfile",
            warnings: [],
          },
        },
      },
    ],
  });
  presentation.sync(pending);
  expect(presentation.snapshot().nextId).toBe(3);
  presentation.sync({ ...pending, approval: null, status: "ready" });
  expect(presentation.snapshot()).toMatchObject({
    turnActive: false,
    pendingId: null,
    status: { activity: "ready", hint: "ready", elapsedMs: null },
  });
});

it("reports an unclassified failure once, without an offer to retry", () => {
  const presentation = createPresentation(context, copy, vi.fn());
  presentation.sync({ ...ready, status: "failed" });
  presentation.sync({ ...ready, status: "failed" });
  expect(presentation.snapshot()).toMatchObject({
    fatal: false,
    nextId: 2,
    turnActive: false,
    transcript: [
      { kind: "banner", context },
      {
        id: "e1",
        kind: "error",
        detail: "",
        message: copy.turn.driverFailed,
        retryable: false,
        retryOffered: false,
      },
    ],
  });
  presentation.sync({ ...ready, status: "cancelled" });
  presentation.sync({ ...ready, status: "cancelled" });
  expect(presentation.snapshot().nextId).toBe(3);
});

it.each([
  {
    failure: {
      detail: "",
      hasPrefix: true,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: true,
    },
    expected: {
      detail: copy.failure.resumeDetail,
      fatal: false,
      message: copy.failure.providerInterrupted,
      retryable: true,
    },
  },
  {
    failure: {
      detail: "The request exceeds the configured inference limits.",
      hasPrefix: false,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: false,
    },
    expected: {
      detail: "The request exceeds the configured inference limits.",
      fatal: false,
      message: copy.failure.providerInterrupted,
      retryable: false,
    },
  },
  {
    failure: {
      detail: "",
      hasPrefix: false,
      kind: "request-failed",
      recoverable: true,
      retryable: false,
    },
    expected: {
      detail: "",
      fatal: false,
      message: copy.failure.requestFailed,
      retryable: false,
    },
  },
  {
    failure: {
      detail: "",
      hasPrefix: false,
      kind: "session-unavailable",
      recoverable: false,
      retryable: false,
    },
    expected: {
      detail: "",
      fatal: true,
      message: copy.failure.sessionUnavailable,
      retryable: false,
    },
  },
  {
    failure: {
      detail: "Error: boom",
      hasPrefix: true,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    },
    expected: {
      detail: "Error: boom",
      fatal: false,
      message: copy.turn.driverFailed,
      retryable: false,
    },
  },
] as const)("maps a classified $failure.kind failure", ({ failure, expected }) => {
  const presentation = createPresentation(context, copy, vi.fn());
  presentation.sync({ ...ready, failure, status: "failed" });
  const snapshot = presentation.snapshot();
  expect(snapshot.fatal).toBe(expected.fatal);
  expect(snapshot.transcript.at(-1)).toMatchObject({
    detail: expected.detail,
    kind: "error",
    message: expected.message,
    retryable: expected.retryable,
    retryOffered: expected.retryable,
  });
});

it("cancels a pending question set when the controller clears it", () => {
  const presentation = createPresentation(context, copy, vi.fn());
  const questions = {
    interruptId: "q1",
    questions: [{ text: "Why?", required: false, choices: [] as string[] }],
  };
  presentation.sync({ ...ready, questions, status: "questions" });
  expect(presentation.snapshot().pendingId).not.toBeNull();
  presentation.sync({ ...ready, status: "ready" });
  expect(presentation.snapshot().pendingId).toBeNull();
  expect(presentation.snapshot().transcript.at(-1)).toMatchObject({
    kind: "questions",
    questions: { decision: { type: "cancel" } },
  });
});

it("accepts the exact message limit and submits the original whitespace", () => {
  const dispatch = vi.fn();
  const presentation = createPresentation(context, copy, dispatch);
  presentation.sync(ready);
  expect(presentation.submit("a".repeat(8192))).toBe(true);
  expect(presentation.submit("  message  ")).toBe(true);
  expect(dispatch).toHaveBeenLastCalledWith({ type: "submit", text: "  message  " });
});

it("maps question snapshots once and preserves their answers until completion or cancellation", () => {
  const presentation = createPresentation(context, copy, vi.fn());
  const questions = {
    interruptId: "q1",
    questions: [{ text: "Why?", required: true, choices: [] }],
  };
  const pending: ConversationSnapshot = { ...ready, status: "questions", questions };
  presentation.sync(pending);
  presentation.questions({ type: "type", value: "Because" });
  presentation.sync(pending);
  expect(presentation.snapshot()).toMatchObject({
    nextId: 2,
    pendingId: "e1",
    turnActive: true,
    status: { activity: "waitingAnswer" },
    transcript: [
      { kind: "banner" },
      { kind: "questions", questions: { answers: new Map([[0, "Because"]]) } },
    ],
  });
  expect(presentation.questions({ type: "submit" })).toEqual({
    type: "answers",
    interruptId: "q1",
    values: ["Because"],
  });
  presentation.sync({ ...ready, status: "streaming" });
  expect(presentation.snapshot().pendingId).toBeNull();
  presentation.sync({ ...pending, questions: { ...questions, interruptId: "q2" } });
  presentation.sync({ ...ready, status: "cancelled" });
  expect(presentation.snapshot().transcript[2]).toMatchObject({
    questions: { decision: { type: "cancel" } },
  });
  expect(presentation.snapshot().pendingId).toBeNull();
});

it("emits started and finished tool events once per call, showing only display keys", () => {
  const presentation = createPresentation(context, copy, vi.fn());
  presentation.sync({ ...ready, status: "streaming" });
  const started = {
    arguments: { content: "unseen", path: "a.txt" },
    callId: "call:1",
    name: "marea_read_project",
    outcome: null,
  } as const;
  presentation.sync({ ...ready, status: "streaming", tools: [started] });
  presentation.sync({ ...ready, status: "streaming", tools: [started] });
  const finished = { ...started, outcome: { failed: false, result: "content" } } as const;
  presentation.sync({ ...ready, status: "streaming", tools: [finished] });
  presentation.sync({
    ...ready,
    messages: [{ author: "marea", text: "Leído." }],
    status: "streaming",
    tools: [finished],
  });
  // A finish already shown is not replayed, so the answer that followed keeps the status.
  expect(presentation.snapshot().status.activity).toBe("responding");
  const tools = presentation.snapshot().transcript.filter((entry) => entry.kind === "tool");
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({
    row: {
      call: { arguments: { path: "a.txt" }, callId: "call:1", name: "marea_read_project" },
      expanded: false,
      outcome: { failed: false, result: "content" },
    },
  });
});

it("opens a failed tool row automatically", () => {
  const presentation = createPresentation(context, copy, vi.fn());
  const started = {
    arguments: { path: "missing.txt" },
    callId: "call:9",
    name: "marea_read_project",
    outcome: null,
  } as const;
  presentation.sync({ ...ready, status: "streaming", tools: [started] });
  presentation.sync({
    ...ready,
    status: "streaming",
    tools: [{ ...started, outcome: { failed: true, result: "cannot read the file" } }],
  });
  const tools = presentation.snapshot().transcript.filter((entry) => entry.kind === "tool");
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ row: { expanded: true } });
});
