import { expect, it, vi } from "vitest";

import { droppedAnswerLength, withoutAnswerTail } from "./answer-restart.js";
import { createConversationController } from "./conversation-controller.js";
import type { ConversationSnapshot } from "./conversation-contracts.js";
import { createPresentation } from "./parity/presentation.js";
import { withoutAssistantTail, type Transcript } from "./parity/transcript.js";
import { PARITY_TEST_COPY as copy } from "../test-support/parity-copy.js";

const student = { author: "student" as const, text: "¿Por qué?" };

it("drops only the end of the final answer", () => {
  expect(withoutAnswerTail([student], "Kept. Lost", 4)).toEqual([
    student,
    { author: "marea", text: "Kept. " },
  ]);
  expect(withoutAnswerTail([student], "Lost", 4)).toEqual([student]);
  expect(withoutAnswerTail([student], "Lost", 9)).toEqual([student]);
  expect(Object.isFrozen(withoutAnswerTail([student], "Kept", 1))).toBe(true);
  expect(Object.isFrozen(withoutAnswerTail([student], "Kept", 1)[1])).toBe(true);
});

it("measures how much of the final answer a snapshot dropped", () => {
  const answer = (text: string) => ({ author: "marea" as const, text });
  expect(droppedAnswerLength([], [student])).toBe(0);
  expect(droppedAnswerLength([student], [student, answer("new")])).toBe(0);
  expect(droppedAnswerLength([student, answer("abc")], [student, answer("abcd")])).toBe(0);
  expect(droppedAnswerLength([student, answer("abcd")], [student, answer("a")])).toBe(3);
  expect(droppedAnswerLength([student, answer("abcd")], [student])).toBe(4);
});

it("removes assistant text newest first, across notices but not across other entries", () => {
  const transcript: Transcript = [
    { id: "u", kind: "user", text: "q" },
    { id: "a1", kind: "assistant", streaming: false, text: "Before tool. " },
    { id: "n0", kind: "notice", text: "older", tone: "plain" },
    { id: "u2", kind: "user", text: "q2" },
    { id: "a2", kind: "assistant", streaming: false, text: "Kept " },
    { id: "a3", kind: "assistant", streaming: false, text: "lost" },
    {
      id: "e",
      kind: "error",
      detail: "",
      technicalDetail: "",
      expanded: false,
      message: "x",
      retryOffered: true,
      retryable: true,
    },
    { id: "n", kind: "notice", text: "retrying", tone: "plain" },
  ];
  expect(withoutAssistantTail(transcript, 6).map((entry) => entry.id)).toEqual([
    "u",
    "a1",
    "n0",
    "u2",
    "a2",
    "e",
    "n",
  ]);
  expect(withoutAssistantTail(transcript, 6)[4]).toMatchObject({ text: "Kep" });
  // A user entry ends the answer: earlier turns are never touched.
  expect(withoutAssistantTail(transcript, 50).map((entry) => entry.id)).toEqual([
    "u",
    "a1",
    "n0",
    "u2",
    "e",
    "n",
  ]);
  expect(withoutAssistantTail(transcript, 0)).toEqual(transcript);
  // Nothing left to remove leaves every entry as it was, even an empty one.
  const settled: Transcript = [
    { id: "empty", kind: "assistant", streaming: false, text: "" },
    { id: "last", kind: "assistant", streaming: false, text: "ab" },
  ];
  expect(withoutAssistantTail(settled, 0)).toEqual(settled);
  expect(withoutAssistantTail(settled, 2)).toEqual([settled[0]]);
});

it("drops text only from the answer of the turn in progress", () => {
  let next = 0;
  const controller = createConversationController({
    nextAttemptId: () => `attempt:${String(++next)}`,
    onExit: vi.fn(),
    onMessage: () => Promise.resolve(),
    view: { dispose: vi.fn(), render: vi.fn() },
  });
  controller.handle({ type: "submit", text: "Primera" });
  expect(controller.complete()).toBe(true);
  return Promise.resolve().then(() => {
    controller.handle({ type: "submit", text: "Segunda" });
    controller.appendAssistantText("abc");
    expect(controller.restartAssistantText(1)).toBe(true);
    expect(controller.snapshot().messages).toEqual([
      { author: "student", text: "Primera" },
      { author: "student", text: "Segunda" },
      { author: "marea", text: "ab" },
    ]);
    controller.dispose();
  });
});

it("ignores a restart before the turn has any message", () => {
  const controller = createConversationController({
    initialTurn: { kind: "startup", messageId: "message:startup", text: "", assistantText: "" },
    onExit: vi.fn(),
    onMessage: () => new Promise(() => undefined),
    view: { dispose: vi.fn(), render: vi.fn() },
  });
  expect(controller.resumeTurn()).toBe(true);
  expect(controller.restartAssistantText(1)).toBe(false);
  controller.dispose();
});

it("replaces an interrupted answer on screen with a notice and the regenerated answer", async () => {
  const snapshots: ConversationSnapshot[] = [];
  let attempts = 0;
  const controller = createConversationController({
    nextAttemptId: () => `attempt:${String(++attempts)}`,
    onExit: vi.fn(),
    onMessage: () => new Promise(() => undefined),
    view: { dispose: vi.fn(), render: (snapshot) => snapshots.push(snapshot) },
  });
  const view = createPresentation(
    { cwd: "/project", branch: "", repositoryUrl: "", model: "" },
    copy,
    vi.fn(),
  );
  controller.handle({ type: "submit", text: "¿Por qué?" });
  expect(controller.restartAssistantText(3)).toBe(false);
  expect(controller.appendAssistantText("Primero, revisa")).toBe(true);
  expect(controller.restartAssistantText(3, "message:other")).toBe(false);
  expect(controller.restartAssistantText(8, undefined, "attempt:1")).toBe(true);
  expect(controller.snapshot().messages).toEqual([
    { author: "student", text: "¿Por qué?" },
    { author: "marea", text: "Primero" },
  ]);
  expect(controller.restartAssistantText(50)).toBe(true);
  expect(controller.appendAssistantText("Vale, empecemos.")).toBe(true);
  for (const snapshot of snapshots) view.sync(snapshot);
  await Promise.resolve();
  const screen = view
    .snapshot()
    .transcript.filter((entry) => entry.kind !== "banner")
    .map((entry) =>
      entry.kind === "assistant" || entry.kind === "user" || entry.kind === "notice"
        ? `${entry.kind}:${entry.text}`
        : entry.kind,
    );
  expect(screen).toEqual([
    "user:¿Por qué?",
    `notice:${copy.notices.regenerated}`,
    `notice:${copy.notices.regenerated}`,
    "assistant:Vale, empecemos.",
  ]);
  controller.dispose();
});
