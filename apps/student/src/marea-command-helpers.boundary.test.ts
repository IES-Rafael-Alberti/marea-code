import { createTranslator } from "@marea/i18n";
import { join, resolve, sep } from "node:path";
import type { ConversationApproval, ConversationCopy } from "@marea/student-tui";
import { describe, expect, it, vi } from "vitest";

import type { StudentConversationPort } from "./conversation-interface.js";
import {
  createBindableConversationPort,
  createConversationCopy,
  createStudentStateDirectory,
} from "./marea-command.boundary.js";

describe("conversation command helpers", () => {
  it("requires a bound conversation and delegates every operation after binding", async () => {
    const bridge = createBindableConversationPort();
    const approval: ConversationApproval = { path: "notes.md", summary: "Create notes" };
    const notReady = "The conversation interface is not ready.";
    expect(() => bridge.appendAssistantText("before")).toThrow(notReady);
    expect(() => bridge.cancel()).toThrow(notReady);
    expect(() => bridge.complete()).toThrow(notReady);
    expect(() => bridge.requestApproval(approval)).toThrow(notReady);
    expect(() =>
      bridge.toolStarted({ arguments: {}, callId: "call:1", name: "marea_read_project" }),
    ).toThrow(notReady);
    expect(() =>
      bridge.toolFinished({ callId: "call:1", failed: false, result: "content" }),
    ).toThrow(notReady);
    const appendAssistantText = vi.fn(() => true);
    const cancel = vi.fn(() => false);
    const complete = vi.fn(() => true);
    const requestApproval = vi.fn(() => Promise.resolve("rejected" as const));
    const toolFinished = vi.fn(() => true);
    const toolStarted = vi.fn(() => true);
    const target: StudentConversationPort = {
      appendAssistantText,
      cancel,
      complete,
      requestApproval,
      thinking: vi.fn(() => true),
      toolFinished,
      toolStarted,
    };

    bridge.bind(target);

    expect(bridge.appendAssistantText("after")).toBe(true);
    expect(bridge.cancel()).toBe(false);
    expect(bridge.complete()).toBe(true);
    await expect(bridge.requestApproval(approval)).resolves.toBe("rejected");
    expect(
      bridge.toolStarted({ arguments: {}, callId: "call:1", name: "marea_read_project" }),
    ).toBe(true);
    expect(bridge.toolFinished({ callId: "call:1", failed: false, result: "content" })).toBe(true);

    expect(bridge.appendAssistantText("active", "message:one", "attempt:one")).toBe(true);
    expect(bridge.complete("message:one", "attempt:one")).toBe(true);
    await expect(bridge.requestApproval(approval, "message:one", "attempt:one")).resolves.toBe(
      "rejected",
    );
    expect(
      bridge.toolStarted(
        { arguments: {}, callId: "call:1", name: "marea_read_project" },
        "message:one",
        "attempt:one",
      ),
    ).toBe(true);
    expect(
      bridge.toolFinished(
        { callId: "call:1", failed: false, result: "content" },
        "message:one",
        "attempt:one",
      ),
    ).toBe(true);
    expect(appendAssistantText.mock.calls.at(-1)).toEqual(["active", "message:one", "attempt:one"]);
    expect(complete.mock.calls.at(-1)).toEqual(["message:one", "attempt:one"]);
    expect(requestApproval.mock.calls.at(-1)).toEqual([approval, "message:one", "attempt:one"]);
    expect(toolStarted.mock.calls.at(-1)).toEqual([
      { arguments: {}, callId: "call:1", name: "marea_read_project" },
      "message:one",
      "attempt:one",
    ]);
    expect(toolFinished.mock.calls.at(-1)).toEqual([
      { callId: "call:1", failed: false, result: "content" },
      "message:one",
      "attempt:one",
    ]);
  });

  it("creates localized conversation copy and stable isolated state paths", () => {
    const copy: ConversationCopy = createConversationCopy(createTranslator("es"));
    const first = createStudentStateDirectory(
      "/home/student/.marea",
      "https://teacher.example",
      "/project",
    );
    const second = createStudentStateDirectory(
      "/home/student/.marea",
      "https://teacher.example",
      "/other-project",
    );

    expect(copy.parity.context).toEqual({ cwd: "", branch: "", model: "", repositoryUrl: "" });
    expect(copy.parity.copy.question.title).toBe("El agente necesita que decidas");
    expect(first).not.toBe(second);
    expect(createStudentStateDirectory("/state", "a", "/b/c")).not.toBe(
      createStudentStateDirectory("/state", "a/b", "/c"),
    );
    expect(
      createStudentStateDirectory("relative", "https://teacher.example", "/project").startsWith(
        `${join(resolve("relative"), "student")}${sep}`,
      ),
    ).toBe(true);
  });
});
