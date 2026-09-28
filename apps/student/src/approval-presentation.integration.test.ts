import { createConversationController } from "@marea/student-tui";
import { expect, it, vi } from "vitest";

import { createConversationStudentInterface } from "./conversation-interface.js";
import { createFixtureController } from "./student.fixture.js";

it("carries the exact proposed write and approval identity through the live conversation", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project One");
  const conversation = createConversationController({
    nextAttemptId: () => "attempt:presentation",
    nextMessageId: () => "message:presentation",
    onExit: vi.fn(),
    onMessage: (text, signal, messageId, attemptId) =>
      fixture.controller.sendMessage(messageId, text, signal, attemptId),
    view: { dispose: vi.fn(), render: vi.fn() },
  });
  const studentInterface = createConversationStudentInterface({
    authentication: fixture.studentInterface,
    conversation,
  });
  fixture.studentInterface.confirmWrite = (prompt) => studentInterface.confirmWrite(prompt);
  fixture.studentInterface.present = (event) => {
    studentInterface.present(event);
  };

  try {
    expect(conversation.handle({ type: "submit", text: "Please add notes." })).toBe(true);
    await vi.waitFor(() => {
      expect(conversation.snapshot().status).toBe("approval");
    });
    expect(conversation.snapshot()).toEqual({
      approval: {
        approvalId: "approval:1",
        toolName: "write_file",
        warnings: [],
        content: "New notes",
        path: "notes.txt",
        summary: "Create notes.txt",
      },
      messages: [
        { author: "student", text: "Please add notes." },
        { author: "marea", text: "I will help. " },
      ],
      status: "approval",
    });
    expect(fixture.workspace.calls).toEqual([]);

    expect(conversation.handle({ type: "approve" })).toBe(true);
    expect(conversation.handle({ type: "approve" })).toBe(false);
    await vi.waitFor(() => {
      expect(conversation.snapshot().status).toBe("ready");
    });
    expect(conversation.snapshot()).toEqual({
      approval: null,
      messages: [
        { author: "student", text: "Please add notes." },
        { author: "marea", text: "I will help. Done." },
      ],
      status: "ready",
    });
    expect(fixture.agent.approvalTurns).toMatchObject([
      { approvalId: "approval:1", content: "New notes", decision: "approved" },
    ]);
    expect(fixture.agent.approvalTurns).toHaveLength(1);
    expect(fixture.workspace.calls).toEqual([
      { content: "New notes", effectId: "effect:1", path: "notes.txt" },
    ]);
  } finally {
    conversation.dispose();
  }
});
