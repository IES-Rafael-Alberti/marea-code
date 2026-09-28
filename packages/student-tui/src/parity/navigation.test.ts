import { expect, it } from "vitest";
import { defaultFocus, focusTargets, nextFocus } from "./navigation.js";
import { applyApproval, applyEvent, applyQuestions, openSession } from "./session-state.js";

it("traverses finished tools and live actions, restores the correct input after interruptions", () => {
  let state = { ...openSession(), starting: false, turnActive: false };
  expect(focusTargets(state)).toEqual(["composer"]);
  expect(defaultFocus(state)).toBe("composer");
  state = applyEvent(state, { type: "assistant-text", text: "Hello" });
  expect(focusTargets(state)).toEqual(["composer"]);
  state = { ...openSession(), starting: false, turnActive: false };
  state = applyEvent(state, { type: "tool-started", callId: "a", name: "read", arguments: {} });
  expect(focusTargets(state)).toEqual(["composer"]);
  state = applyEvent(state, { type: "tool-finished", callId: "a", failed: false, result: "done" });
  state = applyEvent(state, {
    type: "turn-failed",
    message: "Error",
    detail: "",
    recoverable: true,
    retryable: true,
  });
  expect(focusTargets(state)).toEqual(["tool:e0", "retry:e1", "composer"]);
  state = applyEvent(state, {
    type: "approval-requested",
    request: {
      interruptId: "a",
      name: "write_file",
      arguments: {},
      preview: "Write",
      warnings: [],
    },
  });
  expect(focusTargets(state)).toEqual(["tool:e0", "retry:e1", "preview", "approve", "reject"]);
  expect(defaultFocus(state)).toBe("approve");
  state = applyApproval(state, { type: "start-reject" })?.state ?? state;
  expect(defaultFocus(state)).toBe("reason");
  expect(focusTargets(state)).toEqual(["tool:e0", "retry:e1", "reason"]);
  state = applyApproval(state, { type: "cancel" })?.state ?? state;
  state = applyEvent(state, {
    type: "questions-asked",
    request: {
      interruptId: "q",
      questions: [
        { text: "First", choices: [], required: false },
        { text: "Second", choices: [], required: false },
      ],
    },
  });
  expect(defaultFocus(state)).toBe("answer");
  expect(focusTargets(state)).toEqual(["tool:e0", "retry:e1", "answer", "next"]);
  state = applyQuestions(state, { type: "next" })?.state ?? state;
  expect(focusTargets(state)).toEqual(["tool:e0", "retry:e1", "answer", "previous", "next"]);
  const targets = focusTargets(state);
  expect(nextFocus(targets, "next", false)).toBe("tool:e0");
  expect(nextFocus(targets, "tool:e0", true)).toBe("next");
  expect(nextFocus([], "", true)).toBe("");
  expect(nextFocus([], "", false)).toBe("");
  expect(nextFocus(["a", "b", "c"], "missing", true)).toBe("c");
  expect(nextFocus(["a", "b", "c"], "missing", false)).toBe("a");
  expect(nextFocus(["only"], "missing", false)).toBe("only");
  expect(nextFocus(["only"], "missing", true)).toBe("only");
  state = applyQuestions(state, { type: "cancel" })?.state ?? state;
  state = applyEvent(state, {
    type: "turn-failed",
    message: "Fatal",
    detail: "",
    recoverable: false,
    retryable: false,
  });
  expect(defaultFocus(state)).toBe("");
  expect(focusTargets(state)).toEqual(["tool:e0"]);
});
