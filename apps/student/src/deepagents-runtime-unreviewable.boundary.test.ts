import { describe, expect, it } from "vitest";

import {
  approvalRequired,
  batchApprovalRequired,
  collect,
  harness,
  message,
} from "./deepagents-runtime.fixture.js";

const signal = () => new AbortController().signal;

describe("DeepAgents bridge for a call that cannot be reviewed", () => {
  it.each([
    ["marea_write_file", {}, "content"],
    ["marea_write_file", { path: "notes.txt" }, "content"],
    ["marea_write_file", { content: "content" }, "path"],
    ["marea_write_file", { path: "", content: "content" }, "path"],
    ["marea_write_file", { path: "a.txt", content: "x", extra: "y" }, "extra"],
    ["marea_ask_user", { questions: "[]" }, "questions is invalid"],
    ["marea_edit_file", { path: "a.txt" }, "old_string"],
  ])(
    "answers a pending %s call with its problem instead of failing or replaying it: %j",
    async (toolName, args, problem) => {
      const instance = harness(true);
      instance.deep.messages = [
        approvalRequired({ reviewId: "review-bad", toolName, arguments: args }),
      ];
      const events = await collect(instance.runtime.streamMessage(message(), signal()));
      expect(events).toEqual([{ type: "turn-completed" }]);
      expect(instance.deep.resumes).toHaveLength(1);
      expect(instance.deep.resumes[0]).toMatchObject({
        reviewId: "review-bad",
        toolName,
        decision: { type: "reject" },
      });
      const decision = instance.deep.resumes[0]?.decision;
      expect(decision?.type === "reject" ? decision.reason : "").toContain(problem);
    },
  );

  it("answers with the text the model had already streamed", async () => {
    const instance = harness(true);
    instance.deep.messages = [
      { type: "assistant-text-delta", text: "Voy a " },
      { type: "assistant-text-delta", text: "escribir." },
      approvalRequired({ reviewId: "review-bad", arguments: {} }),
    ];
    await collect(instance.runtime.streamMessage(message(), signal()));
    expect(instance.deep.resumes[0]?.assistantText).toBe("Voy a escribir.");
  });

  it("leaves an unsupported tool and a batch to their own failures, whatever their arguments", async () => {
    const unsupported = harness(true);
    unsupported.deep.messages = [approvalRequired({ toolName: "shell", arguments: {} })];
    await expect(collect(unsupported.runtime.streamMessage(message(), signal()))).rejects.toThrow(
      "unsupported tool",
    );
    const batch = harness(true);
    batch.deep.messages = [
      approvalRequired({
        toolName: "marea_write_file",
        arguments: {},
        actions: [
          { index: 0, toolName: "marea_write_file", arguments: {}, description: "Write" },
          {
            index: 1,
            toolName: "marea_execute",
            arguments: { command: "dir" },
            description: "Run",
          },
        ],
      }),
    ];
    await expect(collect(batch.runtime.streamMessage(message(), signal()))).rejects.toThrow(
      "invalid write_file arguments",
    );
    expect(unsupported.deep.resumes).toHaveLength(0);
    expect(batch.deep.resumes).toHaveLength(0);
  });

  it("shows a valid call to the student as before", async () => {
    const instance = harness(true);
    const events = await collect(instance.runtime.streamMessage(message(), signal()));
    expect(events.map((event) => event.type)).toContain("write-approval-required");
    expect(instance.deep.resumes).toHaveLength(0);
  });

  it("keeps failing a batch that holds an unreadable write", async () => {
    const instance = harness(true);
    instance.deep.messages = [
      batchApprovalRequired("review-9", [
        { toolName: "marea_write_file", arguments: {}, description: "Create notes." },
      ]),
    ];
    await expect(collect(instance.runtime.streamMessage(message(), signal()))).rejects.toThrow(
      "invalid write_file arguments",
    );
    expect(instance.deep.resumes).toHaveLength(0);
  });

  async function checks() {
    const instance = harness(true);
    await collect(instance.runtime.streamMessage(message(), signal()));
    const options = instance.options[0];
    const check = (name: string) => options?.effectTools?.find((tool) => tool.name === name);
    return {
      write: options?.approvalTool,
      edit: check("marea_edit_file"),
      command: check("marea_execute"),
      remove: check("marea_delete"),
    };
  }

  it("hands the adapter a check for writes", async () => {
    const { write } = await checks();
    expect(write?.validate?.({ path: "a.txt", content: "x" })).toBeNull();
    expect(write?.validate?.({})).toContain("content");
  });

  it("hands the adapter a check for edits", async () => {
    const { edit } = await checks();
    expect(edit?.validate?.({ path: "a.txt", old_string: "x", new_string: "y" })).toBeNull();
    expect(edit?.validate?.({ path: "a.txt" })).toContain("old_string");
  });

  it("hands the adapter a check for commands and deletions", async () => {
    const { command, remove } = await checks();
    expect(command?.validate?.({ command: "dir" })).toBeNull();
    expect(command?.validate?.({})).toContain("command");
    expect(remove?.validate?.({ path: "a.txt" })).toBeNull();
    expect(remove?.validate?.({ path: "a.txt", extra: "y" })).toContain("extra");
  });
});
