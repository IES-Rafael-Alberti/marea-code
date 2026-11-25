/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars, @typescript-eslint/unbound-method */
import { conversationSession } from "./command-options.fixture.js";
import type {
  ConversationAction,
  ConversationApproval,
  ConversationController,
  ConversationSnapshot,
} from "@marea/student-tui";
import { ApprovalIdSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalPrompt, StudentViewEvent } from "./contracts.js";
import type { AuthenticationPrompt } from "./conversation-interface.js";
import {
  adaptConversationTuiSession,
  createConversationExitSignal,
  createConversationStudentInterface,
} from "./conversation-interface.js";

function conversation(): ConversationController {
  return {
    appendAssistantText: vi.fn(() => true),
    cancel: vi.fn(() => true),
    complete: vi.fn(() => true),
    dispose: vi.fn(() => true),
    fail: vi.fn(() => true),
    handle: vi.fn((_action: ConversationAction) => true),
    requestQuestions: vi.fn(() => Promise.resolve({ type: "cancel" as const })),
    requestApproval: vi.fn(
      async (_approval: ConversationApproval): Promise<"approved"> => "approved",
    ),
    resumeTurn: vi.fn(() => true),
    snapshot: vi.fn((): ConversationSnapshot => ({
      approval: null,
      messages: [],
      status: "ready",
    })),
    reportUsage: vi.fn(() => true),
    thinking: vi.fn(() => true),
    toolFinished: vi.fn(() => true),
    toolStarted: vi.fn(() => true),
  };
}

describe("conversation student interface", () => {
  it("delegates preflight authentication, approval, and presentation to the TUI contract", async () => {
    const authentication: AuthenticationPrompt = {
      authenticate: vi.fn(
        async () =>
          ({
            kind: "login",
            login: "student",
            password: "long-password",
          }) as const,
      ),
      chooseClass: vi.fn(async () => "class:two"),
    };
    const controller = conversation();
    const studentInterface = createConversationStudentInterface({
      authentication,
      conversation: controller,
    });

    await expect(
      studentInterface.authenticate("missing", { providers: [] }),
    ).resolves.toMatchObject({
      kind: "login",
    });
    expect(authentication.authenticate).toHaveBeenCalledWith("missing", { providers: [] });
    const classes = [
      { classId: "class:one", displayName: "One" },
      { classId: "class:two", displayName: "Two" },
    ];
    await expect(studentInterface.chooseClass(classes)).resolves.toBe("class:two");
    expect(authentication.chooseClass).toHaveBeenCalledWith(classes);
    const approvalPrompt: ApprovalPrompt = {
      approvalId: ApprovalIdSchema.parse("approval:1"),
      content: "Exact proposed contents\nSecond line",
      attemptId: "attempt:one",
      messageId: "message:one",
      path: "notes.txt",
      summary: "Write notes.",
    };
    await expect(studentInterface.confirmWrite(approvalPrompt)).resolves.toBe("approved");
    const batch = { position: 1, total: 2, remaining: ["execute dir"] };
    await studentInterface.confirmWrite({ ...approvalPrompt, batch });
    expect(controller.requestApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({ batch }),
      "message:one",
      "attempt:one",
    );
    const assistantEvent = {
      attemptId: "attempt:one",
      messageId: "message:one",
      text: "Hello",
      type: "assistant-text",
    } satisfies StudentViewEvent;
    studentInterface.present(assistantEvent);
    expect(controller.appendAssistantText).toHaveBeenCalledWith(
      "Hello",
      "message:one",
      "attempt:one",
    );
    expect(controller.complete).not.toHaveBeenCalled();
    expect(controller.cancel).not.toHaveBeenCalled();
    const completedEvent = {
      attemptId: "attempt:one",
      messageId: "message:one",
      type: "turn-completed",
    } satisfies StudentViewEvent;
    studentInterface.present(completedEvent);
    expect(controller.complete).toHaveBeenCalledWith("message:one", "attempt:one");
    expect(controller.cancel).not.toHaveBeenCalled();
    studentInterface.present({
      type: "thinking",
      messageId: "message:one",
      attemptId: "attempt:one",
    });
    expect(controller.thinking).toHaveBeenCalledWith("message:one", "attempt:one");
    studentInterface.present({
      type: "skills-loading",
      messageId: "message:one",
      attemptId: "attempt:one",
    });
    expect(controller.thinking).toHaveBeenCalledWith("message:one", "attempt:one", "loadingSkills");
    const usage = { inputTokens: 9, outputTokens: 4, lastInputTokens: 9 };
    studentInterface.showUsage?.(usage);
    expect(controller.reportUsage).toHaveBeenCalledWith(usage);
    const toolStartedEvent = {
      arguments: { path: "exercise.txt" },
      attemptId: "attempt:one",
      callId: "call:1",
      messageId: "message:one",
      name: "marea_read_project",
      type: "tool-started",
    } satisfies StudentViewEvent;
    studentInterface.present(toolStartedEvent);
    expect(controller.toolStarted).toHaveBeenCalledWith(
      { arguments: { path: "exercise.txt" }, callId: "call:1", name: "marea_read_project" },
      "message:one",
      "attempt:one",
    );
    const toolFinishedEvent = {
      attemptId: "attempt:one",
      callId: "call:1",
      failed: false,
      messageId: "message:one",
      result: "content",
      type: "tool-finished",
    } satisfies StudentViewEvent;
    studentInterface.present(toolFinishedEvent);
    expect(controller.toolFinished).toHaveBeenCalledWith(
      { callId: "call:1", failed: false, result: "content" },
      "message:one",
      "attempt:one",
    );
    const cancelledEvent = {
      attemptId: "attempt:one",
      messageId: "message:one",
      type: "turn-cancelled",
    } satisfies StudentViewEvent;
    studentInterface.present(cancelledEvent);

    expect(controller.requestApproval).toHaveBeenCalledWith(
      {
        approvalId: approvalPrompt.approvalId,
        toolName: "write_file",
        warnings: [],
        content: approvalPrompt.content,
        path: "notes.txt",
        summary: "Write notes.",
      },
      "message:one",
      "attempt:one",
    );
    expect(controller.cancel).toHaveBeenCalledOnce();
  });

  it("resolves its exit signal once and allows waiting before or after exit", async () => {
    const signal = createConversationExitSignal();
    let resolutions = 0;
    const pending = signal.wait().then(() => {
      resolutions += 1;
    });
    signal.onExit();
    signal.onExit();
    await pending;
    await signal.wait();
    expect(resolutions).toBe(1);
  });

  it("adapts the exported TUI session surface without requiring its private controller", async () => {
    const session = {
      appendAssistantText: vi.fn(() => true),
      cancel: vi.fn(() => true),
      complete: vi.fn(() => true),
      fail: vi.fn(() => true),
      requestApproval: vi.fn(async (): Promise<"rejected"> => "rejected"),
      reportUsage: vi.fn(() => true),
      thinking: vi.fn(() => true),
      toolFinished: vi.fn(() => true),
      toolStarted: vi.fn(() => true),
    };
    const conversation = adaptConversationTuiSession(session);

    expect(conversation.thinking("message", "attempt")).toBe(true);
    expect(session.thinking).toHaveBeenCalledWith("message", "attempt");
    const usage = { inputTokens: 1, outputTokens: 1, lastInputTokens: 1 };
    expect(conversation.reportUsage(usage)).toBe(true);
    expect(session.reportUsage).toHaveBeenCalledWith(usage);
    expect(conversation.appendAssistantText("Partial")).toBe(true);
    expect(conversation.complete()).toBe(true);
    expect(conversation.cancel()).toBe(true);
    await expect(
      conversation.requestApproval({ path: "notes.txt", summary: "Write" }),
    ).resolves.toBe("rejected");

    expect(session.appendAssistantText).toHaveBeenCalledWith("Partial");
    expect(session.complete).toHaveBeenCalledOnce();
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(session.requestApproval).toHaveBeenCalledWith({ path: "notes.txt", summary: "Write" });
  });

  it.each([
    { attemptId: "attempt:one", messageId: "message:one" },
    { attemptId: undefined, messageId: "message:one" },
    { attemptId: "attempt:one", messageId: undefined },
  ])(
    "forwards event identities $messageId/$attemptId through the TUI adapter",
    async (identity) => {
      const session = conversationSession();
      const conversation = adaptConversationTuiSession(session);
      const approval = { path: "notes.txt", summary: "Write" };

      conversation.appendAssistantText("Tagged", identity.messageId, identity.attemptId);
      conversation.cancel(identity.messageId, identity.attemptId);
      conversation.complete(identity.messageId, identity.attemptId);
      await expect(
        conversation.requestApproval(approval, identity.messageId, identity.attemptId),
      ).resolves.toBe("approved");

      expect(session.appendAssistantText).toHaveBeenCalledWith(
        "Tagged",
        identity.messageId,
        identity.attemptId,
      );
      expect(session.cancel).toHaveBeenCalledWith(identity.messageId, identity.attemptId);
      expect(session.complete).toHaveBeenCalledWith(identity.messageId, identity.attemptId);
      expect(session.requestApproval).toHaveBeenCalledWith(
        approval,
        identity.messageId,
        identity.attemptId,
      );
      expect(session.appendAssistantText.mock.contexts[0]).toBe(session);
      expect(session.cancel.mock.contexts[0]).toBe(session);
      expect(session.complete.mock.contexts[0]).toBe(session);
      expect(session.requestApproval.mock.contexts[0]).toBe(session);
    },
  );
});
it.each(["execute", "edit_file"])(
  "presents reviewed %s arguments and the command's permission warning",
  async (toolName) => {
    const controller = conversation();
    const studentInterface = createConversationStudentInterface({
      authentication: { authenticate: vi.fn(), chooseClass: vi.fn() },
      conversation: controller,
    });
    const args = { command: "printf synthetic", path: "main.ts" };
    await studentInterface.confirmWrite({
      approvalId: ApprovalIdSchema.parse("approval:operation"),
      messageId: "message:one",
      attemptId: "attempt:one",
      toolName,
      arguments: args,
      path: "main.ts",
      content: "review",
      summary: "Review",
    });
    expect(controller.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName,
        arguments: args,
        warnings: toolName === "execute" ? [expect.stringContaining("fuera del proyecto")] : [],
      }),
      "message:one",
      "attempt:one",
    );
  },
);

it("protects class selection with the same authentication ownership scope", async () => {
  let owned = false;
  const authentication: AuthenticationPrompt = {
    authenticate: vi.fn(),
    chooseClass: vi.fn(async () => {
      expect(owned).toBe(true);
      return "class:two";
    }),
  };
  const student = createConversationStudentInterface({
    authentication,
    conversation: conversation(),
    async withAuthentication<T>(operation: () => Promise<T>): Promise<T> {
      owned = true;
      try {
        return await operation();
      } finally {
        owned = false;
      }
    },
  });
  await expect(student.chooseClass([{ classId: "class:two", displayName: "Two" }])).resolves.toBe(
    "class:two",
  );
  expect(owned).toBe(false);
});
