import { expect, it, vi } from "vitest";
import { createPresentation } from "./presentation.js";
import { PARITY_TEST_COPY as copy } from "../../test-support/parity-copy.js";
const context = { cwd: "/project", branch: "", repositoryUrl: "", model: "" };

it("keeps and recalls the draft, toggles real outputs and records only accepted submissions", () => {
  const remember = vi.fn();
  const dispatch = vi.fn();
  const view = createPresentation(context, copy, dispatch, { entries: ["old"], remember });
  view.sync({ approval: null, messages: [], status: "ready" });
  expect(view.recall(false, "draft")).toBeNull();
  expect(view.recall(true, "draft")).toBe("old");
  expect(view.recall(true, "old")).toBeNull();
  expect(view.recall(false, "old")).toBe("draft");
  expect(view.submit(" hello ")).toBe(true);
  expect(remember).toHaveBeenCalledExactlyOnceWith("hello");
  view.toggleLastOutput();
  view.toggleTurnOutputs();
  expect(
    view
      .snapshot()
      .transcript.slice(-2)
      .map((entry) => entry.kind === "notice" && entry.text),
  ).toEqual([copy.notices.noOutputs, copy.notices.noTurnOutputs]);
  view.sync({
    approval: null,
    messages: [{ author: "student", text: "hello" }],
    status: "streaming",
    tools: [
      { callId: "a", name: "read", arguments: {}, outcome: { failed: false, result: "done" } },
    ],
  });
  const tool = () => view.snapshot().transcript.find((entry) => entry.kind === "tool");
  expect(tool()?.row).toMatchObject({ expanded: false, outcome: { result: "done" } });
  view.toggleTool(tool()?.id ?? "missing");
  expect(tool()?.row.expanded).toBe(true);
  view.toggleLastOutput();
  expect(tool()?.row.expanded).toBe(false);
  view.toggleTurnOutputs();
  expect(tool()?.row.expanded).toBe(true);
  view.toggleTurnOutputs();
  expect(tool()?.row.expanded).toBe(false);
  view.submit("/details");
  expect(tool()?.row.expanded).toBe(true);
  view.submit("/details");
  expect(tool()?.row.expanded).toBe(false);
  expect(view.submit("busy draft")).toBe(false);
  expect(remember).toHaveBeenCalledTimes(1);
  view.toggleTool("missing");
});

it("withdraws a retry immediately and honours fatal failures", () => {
  const dispatch = vi.fn();
  const view = createPresentation(context, copy, dispatch);
  const failure = {
    detail: "",
    kind: "unexpected" as const,
    hasPrefix: false,
    recoverable: true,
    retryable: true,
  };
  view.sync({ approval: null, messages: [], status: "failed", failure });
  view.submit("/help");
  view.retry();
  view.retry();
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "retry" });
  view.sync({ approval: null, messages: [], status: "ready" });
  view.sync({
    approval: null,
    messages: [],
    status: "failed",
    failure: { ...failure, recoverable: false, retryable: false },
  });
  expect(view.submit("another message")).toBe(false);
});

it("keeps failed outputs expanded when details mode becomes compact", () => {
  const view = createPresentation(context, copy, vi.fn());
  view.sync({
    approval: null,
    messages: [],
    status: "ready",
    tools: [
      { callId: "bad", name: "read", arguments: {}, outcome: { result: "error", failed: true } },
    ],
  });
  const tool = view.snapshot().transcript.find((entry) => entry.kind === "tool");
  view.toggleTool(tool?.id ?? "missing");
  expect(view.snapshot().transcript.find((entry) => entry.kind === "tool")?.row.expanded).toBe(
    false,
  );
  view.submit("/details");
  view.submit("/details");
  expect(view.snapshot().transcript.find((entry) => entry.kind === "tool")?.row.expanded).toBe(
    true,
  );
});

it("changes only finished tool rows in the requested turn and keeps other entries intact", () => {
  const view = createPresentation(context, copy, vi.fn());
  const old = {
    callId: "old",
    name: "read",
    arguments: {},
    outcome: { failed: false, result: "old" },
  };
  const running = { callId: "running", name: "read", arguments: {}, outcome: null };
  const recent = { ...old, callId: "recent" };
  view.sync({
    approval: null,
    status: "ready",
    messages: [{ author: "student", text: "first" }],
    tools: [old],
  });
  const oldId = view.snapshot().transcript.find((entry) => entry.kind === "tool")?.id;
  view.sync({
    approval: null,
    status: "streaming",
    messages: [
      { author: "student", text: "first" },
      { author: "student", text: "second" },
    ],
    tools: [old, recent, running],
  });
  const initial = view.snapshot().transcript;
  const rows = () => view.snapshot().transcript.filter((entry) => entry.kind === "tool");
  const recentId = rows()[1]?.id;
  const runningId = rows()[2]?.id;
  expect(view.toggleLastOutput()).toBe(recentId);
  expect(rows().map((entry) => entry.row.expanded)).toEqual([false, true, false]);
  view.toggleTool(runningId ?? "missing");
  expect(rows().map((entry) => entry.row.expanded)).toEqual([false, true, false]);
  view.toggleTool(oldId ?? "missing");
  view.toggleTurnOutputs();
  expect(rows().map((entry) => entry.row.expanded)).toEqual([true, false, false]);
  view.submit("/details");
  expect(rows().map((entry) => entry.row.expanded)).toEqual([true, true, false]);
  expect(
    view
      .snapshot()
      .transcript.filter((entry) => entry.kind !== "tool")
      .slice(0, 3),
  ).toEqual(initial.filter((entry) => entry.kind !== "tool"));
  expect(view.submit("draft")).toBe(false);
  expect(view.snapshot().transcript.at(-1)).toMatchObject({ text: copy.notices.draftKept });
  const before = view.snapshot().transcript;
  view.toggleTool("absent");
  expect(view.snapshot().transcript).toEqual(before);
});

it("expands a mixed turn together, records normalized history, and binds legacy approvals safely", () => {
  const view = createPresentation(context, copy, vi.fn());
  view.sync({
    approval: null,
    status: "ready",
    messages: [],
    tools: [
      { callId: "one", name: "read", arguments: {}, outcome: { failed: false, result: "one" } },
      { callId: "two", name: "read", arguments: {}, outcome: { failed: false, result: "two" } },
    ],
  });
  view.toggleLastOutput();
  view.toggleTurnOutputs();
  expect(
    view
      .snapshot()
      .transcript.filter((entry) => entry.kind === "tool")
      .map((entry) => entry.row.expanded),
  ).toEqual([true, true]);
  view.submit("  hello  ");
  expect(view.recall(true, "draft")).toBe("hello");
  view.sync({ approval: { path: "file", summary: "Write" }, messages: [], status: "approval" });
  expect(view.snapshot().transcript.at(-1)).toMatchObject({
    approval: { request: { interruptId: "" } },
  });
});

it("does not retry an old offer once the conversation is ready again", () => {
  const dispatch = vi.fn();
  const view = createPresentation(context, copy, dispatch);
  view.sync({
    approval: null,
    messages: [],
    status: "failed",
    failure: {
      kind: "unexpected",
      detail: "",
      hasPrefix: false,
      retryable: true,
      recoverable: true,
    },
  });
  view.sync({ approval: null, messages: [], status: "ready" });
  view.retry();
  expect(dispatch).not.toHaveBeenCalled();
  expect(view.snapshot().transcript.at(-1)).toMatchObject({ text: copy.notices.noRetry });
  view.sync({
    approval: null,
    messages: [],
    status: "failed",
    failure: {
      kind: "unexpected",
      detail: "",
      hasPrefix: false,
      retryable: false,
      recoverable: true,
    },
  });
  view.retry();
  expect(dispatch).not.toHaveBeenCalled();
});

it("anchors a turn expansion on its last output when it contains three tools", () => {
  const view = createPresentation(context, copy, vi.fn());
  view.sync({
    approval: null,
    status: "ready",
    messages: [],
    tools: ["first", "middle", "last"].map((callId) => ({
      callId,
      name: "read",
      arguments: {},
      outcome: { failed: false, result: callId },
    })),
  });
  const rows = view.snapshot().transcript.filter((entry) => entry.kind === "tool");
  expect(view.toggleTurnOutputs()).toBe(rows[2]?.id);
});

it("announces an accepted retry before dispatching it", () => {
  const dispatch = vi.fn();
  const view = createPresentation(context, copy, dispatch);
  view.sync({
    approval: null,
    messages: [],
    status: "failed",
    failure: {
      kind: "request-failed",
      detail: "Offline",
      hasPrefix: false,
      recoverable: true,
      retryable: true,
    },
  });
  view.retry();
  expect(view.snapshot().transcript.at(-1)).toMatchObject({
    kind: "notice",
    text: copy.notices.retrying,
  });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "retry" });
});

it("reports cancellation unless the last panel itself already says cancelled", () => {
  const ready = { messages: [], approval: null, status: "ready" as const };
  const pending = {
    approval: { approvalId: "a", content: "x", path: "file", summary: "write" },
    messages: [],
    status: "approval" as const,
  };
  const view = createPresentation(context, copy, vi.fn());
  view.sync(pending);
  view.approve({ type: "approve" });
  view.sync({ ...ready, status: "cancelled" });
  expect(view.snapshot().transcript.at(-1)).toMatchObject({
    kind: "notice",
    text: copy.turn.interrupted,
  });
  const unresolved = createPresentation(context, copy, vi.fn());
  unresolved.sync({ ...pending, status: "cancelled" });
  expect(unresolved.snapshot().transcript.at(-1)).toMatchObject({
    kind: "notice",
    text: copy.turn.interrupted,
  });
  const later = createPresentation(context, copy, vi.fn());
  later.sync(pending);
  later.approve({ type: "cancel" });
  later.present({ type: "assistant-text", text: "later turn" });
  later.sync({ ...ready, status: "cancelled" });
  expect(later.snapshot().transcript.at(-1)).toMatchObject({
    kind: "notice",
    text: copy.turn.interrupted,
  });
});

it("reports cancellation before any transcript entry exists", () => {
  const view = createPresentation(context, copy, vi.fn());
  view.sync({ messages: [], approval: null, status: "cancelled" });
  expect(view.snapshot().transcript.at(-1)).toMatchObject({
    kind: "notice",
    text: copy.turn.interrupted,
  });
});

it.each(["ready", "failed", "cancelled"] as const)(
  "removes the retry-in-progress notice when an attempt becomes %s",
  (status) => {
    const view = createPresentation(context, copy, vi.fn());
    const failure = {
      detail: "Interrupted",
      kind: "provider-interrupted" as const,
      hasPrefix: true,
      recoverable: true,
      retryable: true,
    };
    view.sync({ approval: null, messages: [], status: "failed", failure });
    view.retry();
    view.sync({ approval: null, messages: [], status: "streaming" });
    expect(JSON.stringify(view.snapshot().transcript)).toContain(copy.notices.retrying);
    view.sync({
      approval: null,
      messages: [],
      status,
      ...(status === "failed" ? { failure: { ...failure, retryable: false } } : {}),
    });
    expect(JSON.stringify(view.snapshot().transcript)).not.toContain(copy.notices.retrying);
    expect(
      view
        .snapshot()
        .transcript.filter((entry) => entry.kind === "error")
        .every((entry) => !entry.retryable),
    ).toBe(true);
  },
);

it.each([
  ["deadline-exceeded", copy.failure.deadlineExceeded],
  ["budget-exhausted", copy.failure.budgetExhausted],
  ["concurrency-limited", copy.failure.concurrencyLimited],
  ["recovery-pending", copy.failure.recoveryPending],
] as const)("presents the distinct %s failure", (kind, message) => {
  const view = createPresentation(context, copy, vi.fn());
  view.sync({
    approval: null,
    messages: [],
    status: "failed",
    failure: { kind, detail: "Safe detail", hasPrefix: true, retryable: false, recoverable: true },
  });
  expect(view.snapshot().transcript.at(-1)).toMatchObject({
    kind: "error",
    message,
    detail: "Safe detail",
    retryable: false,
    retryOffered: false,
  });
});

it.each([
  ["provider-interrupted", false, true, false],
  ["provider-interrupted", true, true, true],
  ["provider-interrupted", true, false, false],
  ["request-failed", true, true, false],
] as const)(
  "offers prefix recovery only for eligible interruption (%s, %s, %s)",
  (kind, hasPrefix, retryable, resume) => {
    const view = createPresentation(context, copy, vi.fn());
    view.sync({
      approval: null,
      messages: [],
      status: "failed",
      failure: {
        kind,
        hasPrefix,
        retryable,
        recoverable: true,
        detail: "Original failure",
      },
    });
    expect(view.snapshot().transcript.at(-1)).toMatchObject({
      detail: resume ? copy.failure.resumeDetail : "Original failure",
    });
  },
);

it("keeps a current retry offer and leaves non-error transcript entries unchanged", () => {
  const view = createPresentation(context, copy, vi.fn());
  const snapshot = {
    approval: null,
    messages: [{ author: "student" as const, text: "Question" }],
    status: "failed" as const,
    failure: {
      kind: "provider-interrupted" as const,
      hasPrefix: true,
      retryable: true,
      recoverable: true,
      detail: "Interrupted",
    },
  };
  view.sync(snapshot);
  const before = view.snapshot().transcript;
  view.sync(snapshot);
  expect(view.snapshot().transcript).toStrictEqual(before);
  expect(view.snapshot().transcript[0]).not.toHaveProperty("retryable");
  expect(view.snapshot().transcript.at(-1)).toMatchObject({ retryable: true, retryOffered: true });
});

it("shows generic thinking before text, during internal work and after waiting", () => {
  const ready = { messages: [], approval: null, status: "ready" } as const;
  const presentation = createPresentation(context, copy, vi.fn());
  presentation.sync(ready);
  presentation.sync({ ...ready, status: "streaming" });
  expect(presentation.snapshot().status).toMatchObject({
    activity: "thinking",
    elapsedMs: 0,
    hint: "turn",
    toolName: "",
  });
  const messages = [{ author: "marea" as const, text: "Let me check." }];
  presentation.sync({ ...ready, messages, status: "streaming" });
  expect(presentation.snapshot().status.activity).toBe("responding");
  const responding = presentation.snapshot();
  presentation.sync({ ...ready, messages, status: "streaming" });
  expect(presentation.snapshot()).toStrictEqual(responding);
  presentation.sync({ ...ready, messages, status: "streaming", activity: "thinking" });
  expect(presentation.snapshot().status.activity).toBe("thinking");
  expect(presentation.snapshot().transcript.at(-1)).toMatchObject({
    kind: "assistant",
    streaming: false,
  });
  const count = presentation.snapshot().transcript.length;
  presentation.sync({ ...ready, messages, status: "streaming", activity: "thinking" });
  expect(presentation.snapshot().transcript).toHaveLength(count);
  presentation.sync({
    ...ready,
    messages: [{ author: "marea", text: "Let me check. Done." }],
    status: "streaming",
  });
  expect(presentation.snapshot().status.activity).toBe("responding");
  presentation.sync({ ...ready, status: "ready", activity: "thinking" });
  expect(presentation.snapshot().status.activity).toBe("ready");
});
