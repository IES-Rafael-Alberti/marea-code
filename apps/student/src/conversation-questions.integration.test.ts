import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createConversationController, type ConversationTuiOptions } from "@marea/student-tui";
import {
  createConversationStudentInterface,
  adaptConversationTuiSession,
} from "./conversation-interface.js";
import { createBindableConversationPort, executeMareaCommand } from "./marea-command.boundary.js";
import { commandOptions, testConversationRuntime } from "./command-options.fixture.js";
import type { ProductionStudentCompositionOptions } from "./composition.js";

const request = { interruptId: "q1", questions: [{ text: "Why?", choices: [], required: true }] };
function conversation() {
  return createConversationController({
    onExit: vi.fn(),
    onMessage: () =>
      new Promise(() => {
        /* The test controls the pending turn. */
      }),
    view: { dispose: vi.fn(), render: vi.fn() },
  });
}

it("passes questions through both adapters and rejects unsupported or unbound sessions", async () => {
  const controller = conversation();
  const port = createBindableConversationPort();
  const authentication = { authenticate: vi.fn(), chooseClass: vi.fn() };
  expect(() => port.requestQuestions?.(request)).toThrow("not ready");
  const adapted = adaptConversationTuiSession(controller);
  port.bind(adapted);
  const student = createConversationStudentInterface({ authentication, conversation: port });
  controller.handle({ type: "submit", text: "Hello" });
  const reply = student.askQuestions?.({
    ...request,
    messageId: "message:1",
    attemptId: "attempt:1",
  });
  expect(controller.snapshot().questions).toEqual(request);
  controller.handle({ type: "answers", interruptId: "q1", values: ["Because"] });
  await expect(reply).resolves.toEqual({ type: "answers", values: ["Because"] });
  const { requestQuestions: removed, ...legacy } = {
    ...controller,
    requestQuestions: controller.requestQuestions.bind(controller),
  };
  expect(removed).toBeDefined();
  port.bind(adaptConversationTuiSession(legacy));
  expect(() => port.requestQuestions?.(request)).toThrow("does not support questions");
  await expect(
    createConversationStudentInterface({ authentication, conversation: legacy }).askQuestions?.({
      ...request,
      messageId: "m",
      attemptId: "a",
    }),
  ).rejects.toThrow("does not support questions");
  controller.dispose();
});

it("supplies and flushes persistent history in the command lifecycle", async () => {
  const exit = Promise.withResolvers<{ exitCode: 0; reason: "closed" }>();
  const ready = Promise.withResolvers<undefined>();
  const history = { entries: ["old"], remember: vi.fn(), flush: vi.fn(() => Promise.resolve()) };
  const controller = conversation();
  const started: ConversationTuiOptions[] = [];
  const compositions: ProductionStudentCompositionOptions[] = [];
  const openHistory = vi.fn(() => Promise.resolve(history));
  const runtime = {
    ...testConversationRuntime((options) => {
      started.push(options);
      ready.resolve(undefined);
      return Promise.resolve({
        ...controller,
        close: () => controller.dispose(),
        outcome: exit.promise,
      });
    }),
    createApplication: (options: ProductionStudentCompositionOptions) => {
      compositions.push(options);
      return Promise.resolve({
        controller: {
          close: () => Promise.resolve(),
          start: () => Promise.resolve({}),
          sendMessage: () => Promise.resolve(),
          pendingTurn: () => Promise.resolve(null),
        },
        dispose: vi.fn(),
      });
    },
    openHistory,
  };
  const running = executeMareaCommand(commandOptions(), runtime);
  await ready.promise;
  await nextTurn();
  expect(history.flush).not.toHaveBeenCalled();
  exit.resolve({ exitCode: 0, reason: "closed" });
  await expect(running).resolves.toBe(0);
  expect(started[0]?.copy.parity.history).toBe(history);
  expect(openHistory).toHaveBeenCalledOnce();
  expect(history.flush).toHaveBeenCalledOnce();
  expect(compositions).toHaveLength(1);
  controller.dispose();
});
