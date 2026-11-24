import { expect, it, vi } from "vitest";
import { createPresentation } from "./presentation.js";
import { PARITY_TEST_COPY as copy } from "../../test-support/parity-copy.js";
const context = { cwd: "/project", branch: "", repositoryUrl: "", model: "" };

it.each([
  ["upstream-contract-changed", "unexpected", copy.failure.actionNotPrepared],
  ["invalid-response", "request-failed", copy.failure.invalidResponse],
  ["other-code", "request-failed", copy.failure.requestFailed],
] as const)("tells the student what to do for %s, in their language", (code, kind, message) => {
  const view = createPresentation(context, copy, vi.fn());
  view.sync({
    approval: null,
    messages: [],
    status: "failed",
    failure: {
      code,
      kind,
      detail: "The inference provider returned an invalid tool call.",
      hasPrefix: false,
      recoverable: true,
      retryable: true,
    },
  });
  expect(view.snapshot().transcript.at(-1)).toMatchObject({
    message,
    detail: "",
    technicalDetail: "The inference provider returned an invalid tool call.",
    expanded: false,
  });
});

it("reveals technical failure detail and the local failure log with /details", () => {
  const view = createPresentation(
    { ...context, failureLog: "/state/turn-failures.jsonl" },
    copy,
    vi.fn(),
  );
  view.sync({
    approval: null,
    messages: [],
    status: "failed",
    failure: {
      kind: "unexpected",
      detail: "TypeError: x",
      hasPrefix: false,
      recoverable: true,
      retryable: false,
    },
  });
  view.submit("/details");
  expect(view.snapshot().transcript.find((entry) => entry.kind === "error")).toMatchObject({
    expanded: true,
  });
  expect(view.snapshot().transcript.at(-1)).toMatchObject({
    kind: "notice",
    text: `${copy.notices.outputsDetailed}\nRegistro de fallos en este equipo: /state/turn-failures.jsonl`,
  });
  view.sync({ approval: null, messages: [], status: "streaming" });
  view.sync({
    approval: null,
    messages: [],
    status: "failed",
    failure: {
      kind: "unexpected",
      detail: "Second",
      hasPrefix: false,
      recoverable: true,
      retryable: false,
    },
  });
  expect(view.snapshot().transcript.at(-1)).toMatchObject({ kind: "error", expanded: true });
  view.submit("/details");
  expect(view.snapshot().transcript.at(-1)).toMatchObject({
    kind: "notice",
    text: copy.notices.outputsCompact,
  });
  const plain = createPresentation(context, copy, vi.fn());
  plain.submit("/details");
  expect(plain.snapshot().transcript.at(-1)).toMatchObject({ text: copy.notices.outputsDetailed });
});
