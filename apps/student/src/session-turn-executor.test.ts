import { ModelStreamError } from "@marea/deepagents-adapter";
import { ApprovalIdSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { TurnAttemptFailed } from "./contracts.js";
import { captureRejection } from "./session-test.boundary.js";
import { FixtureAgent, createFixtureController } from "./student.fixture.js";

function approvalAgent(): FixtureAgent {
  const agent = new FixtureAgent();
  agent.streamMessage = async function* () {
    await Promise.resolve();
    yield {
      approvalId: ApprovalIdSchema.parse("approval:failure"),
      content: "Content",
      path: "notes.txt",
      summary: "Write notes.txt",
      type: "write-approval-required",
    };
  };
  return agent;
}

describe("SessionTurnExecutor", () => {
  it("records one durable student-message event for an ordinary turn", async () => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield { type: "turn-completed" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");

    await fixture.controller.sendMessage(
      "message:ordinary",
      "Please help me.",
      new AbortController().signal,
    );

    const run = fixture.state.state.run;
    expect(run?.turns.at(-1)).toMatchObject({
      messageId: "message:ordinary",
      state: "completed",
    });
    expect(run?.turns.at(-1)?.kind).toBeUndefined();
    expect(run?.eventKeys.filter((key) => key === "student:message:ordinary")).toEqual([
      "student:message:ordinary",
    ]);
    const studentEvents = Array.from(fixture.server.events.values()).filter(
      (event) => event.eventType === "student-message" && event.messageId === "message:ordinary",
    );
    expect(studentEvents).toMatchObject([
      {
        content: "Please help me.",
        eventType: "student-message",
        messageId: "message:ordinary",
      },
    ]);
  });

  it("passes the accumulated assistant prefix through every approval loop", async () => {
    const firstApproval = ApprovalIdSchema.parse("approval:1");
    const secondApproval = ApprovalIdSchema.parse("approval:2");
    const agent = new FixtureAgent();
    agent.streamMessage = async function* (turn) {
      await Promise.resolve();
      this.messageTurns.push(turn);
      this.messages += 1;
      yield { text: "Before first. ", type: "assistant-text-delta" };
      yield {
        approvalId: firstApproval,
        content: "First content",
        path: "first.txt",
        summary: "Write first.txt",
        type: "write-approval-required",
      };
    };
    let resumeCount = 0;
    agent.resumeApproval = async function* (turn) {
      await Promise.resolve();
      this.approvalTurns.push(turn);
      this.resumes += 1;
      resumeCount += 1;
      if (resumeCount === 1) {
        yield { text: "After first. ", type: "assistant-text-delta" };
        yield {
          approvalId: secondApproval,
          content: "Second content",
          path: "second.txt",
          summary: "Write second.txt",
          type: "write-approval-required",
        };
        return;
      }
      yield { text: "Complete.", type: "assistant-text-delta" };
      yield { type: "turn-completed" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");

    await fixture.controller.sendMessage(
      "message:multiple-approvals",
      "Write both files.",
      new AbortController().signal,
      "attempt:multiple-approvals",
    );

    expect(agent.messageTurns[0]?.assistantText).toBe("");
    expect(agent.approvalTurns.map((turn) => turn.assistantText)).toEqual([
      "Before first. ",
      "Before first. After first. ",
    ]);
    expect(fixture.workspace.calls).toEqual([
      { content: "First content", effectId: "effect:1", path: "first.txt" },
      { content: "Second content", effectId: "effect:2", path: "second.txt" },
    ]);
    expect(fixture.studentInterface.prompts).toEqual([
      {
        approvalId: firstApproval,
        attemptId: "attempt:multiple-approvals",
        content: "First content",
        messageId: "message:multiple-approvals",
        path: "first.txt",
        summary: "Write first.txt",
      },
      {
        approvalId: secondApproval,
        attemptId: "attempt:multiple-approvals",
        content: "Second content",
        messageId: "message:multiple-approvals",
        path: "second.txt",
        summary: "Write second.txt",
      },
    ]);
    expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({
      state: "completed",
      text: "Before first. After first. Complete.",
    });
  });

  it("cancels before prompting when approval is already aborted", async () => {
    const fixture = createFixtureController({ agent: approvalAgent() });
    await fixture.controller.start("Project One");
    const abort = new AbortController();
    abort.abort();

    await fixture.controller.sendMessage("message:aborted", "Stop.", abort.signal);

    expect(fixture.studentInterface.prompts).toEqual([]);
    expect(fixture.state.state.run?.approvals).toEqual([
      { approvalId: "approval:failure", decision: "rejected" },
    ]);
    expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({ state: "cancelled" });
  });

  it("removes its approval abort listener after confirmation settles", async () => {
    const fixture = createFixtureController({ agent: approvalAgent() });
    await fixture.controller.start("Project One");
    const abort = new AbortController();
    const removeListener = vi.spyOn(AbortSignal.prototype, "removeEventListener");

    try {
      await fixture.controller.sendMessage("message:approved", "Continue.", abort.signal);

      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      removeListener.mockRestore();
    }
  });

  it("preserves Error approvals and safely normalizes non-Error failures", async () => {
    for (const [failure, message, messageId] of [
      [new Error("approval failed"), "approval failed", "message:error-failure"],
      ["private failure", "Write approval failed.", "message:non-error-failure"],
    ] as const) {
      const fixture = createFixtureController({ agent: approvalAgent() });
      fixture.studentInterface.confirmWrite = () =>
        new Promise((_resolve, reject) => {
          Reflect.apply(reject, undefined, [failure]);
        });
      await fixture.controller.start("Project One");

      const rejection = await captureRejection(
        fixture.controller.sendMessage(messageId, "Try.", new AbortController().signal),
      );
      expect(rejection).toBeInstanceOf(TurnAttemptFailed);
      if (rejection instanceof TurnAttemptFailed) {
        expect(rejection.prefix).toBe("");
        expect(rejection.cause).toBeInstanceOf(Error);
        expect(rejection.cause.message).toBe(message);
      }
    }
  });

  it("wraps a lost stream with its persisted prefix", async () => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield { text: "Saved prefix", type: "assistant-text-delta" };
      throw new Error("connection lost");
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");

    const rejection = await captureRejection(
      fixture.controller.sendMessage("message:lost", "Try.", new AbortController().signal),
    );
    expect(rejection).toBeInstanceOf(TurnAttemptFailed);
    if (rejection instanceof TurnAttemptFailed) {
      expect(rejection.message).toBe("The student turn attempt failed.");
      expect(rejection.prefix).toBe("Saved prefix");
      expect(rejection.cause.message).toBe("connection lost");
    }
  });

  it("presents tool rows without persisting them as turn text", async () => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield {
        arguments: { path: "exercise.txt" },
        callId: "call:1",
        name: "marea_read_project",
        type: "tool-started",
      };
      yield {
        callId: "call:1",
        failed: false,
        result: "Synthetic project text.",
        type: "tool-finished",
      };
      yield { type: "turn-completed" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");

    await fixture.controller.sendMessage(
      "message:tools",
      "Read the exercise.",
      new AbortController().signal,
    );

    const completed = fixture.studentInterface.events.find(
      (event) => event.type === "turn-completed",
    );
    if (completed?.type !== "turn-completed") throw new Error("Expected a completed turn.");
    expect(
      fixture.studentInterface.events.filter(
        (event) => event.type === "tool-started" || event.type === "tool-finished",
      ),
    ).toEqual([
      {
        arguments: { path: "exercise.txt" },
        attemptId: completed.attemptId,
        callId: "call:1",
        messageId: "message:tools",
        name: "marea_read_project",
        type: "tool-started",
      },
      {
        attemptId: completed.attemptId,
        callId: "call:1",
        failed: false,
        messageId: "message:tools",
        result: "Synthetic project text.",
        type: "tool-finished",
      },
    ]);
    expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({
      messageId: "message:tools",
      state: "completed",
    });
    expect(fixture.state.state.run?.turns.at(-1)).not.toHaveProperty("text");
  });

  it("reports an unterminated stream with its persisted prefix", async () => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield { text: "Partial ", type: "assistant-text-delta" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");

    const rejection = await captureRejection(
      fixture.controller.sendMessage("message:unterminated", "Try.", new AbortController().signal),
    );
    expect(rejection).toBeInstanceOf(TurnAttemptFailed);
    if (rejection instanceof TurnAttemptFailed) {
      expect(rejection.prefix).toBe("Partial ");
      expect(rejection.cause.message).toBe("The agent stream ended without a terminal event.");
    }
  });

  it("wraps a resumed stream failure once", async () => {
    const agent = approvalAgent();
    agent.resumeApproval = async function* () {
      await Promise.resolve();
      yield { text: "Resumed ", type: "assistant-text-delta" };
      throw new Error("resume lost");
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");

    const rejection = await captureRejection(
      fixture.controller.sendMessage("message:resume-lost", "Try.", new AbortController().signal),
    );
    expect(rejection).toBeInstanceOf(TurnAttemptFailed);
    if (rejection instanceof TurnAttemptFailed) {
      expect(rejection.prefix).toBe("Resumed ");
      expect(rejection.cause).toBeInstanceOf(Error);
      expect(rejection.cause).not.toBeInstanceOf(TurnAttemptFailed);
      expect(rejection.cause.message).toBe("resume lost");
    }
  });
});

it.each([false, true])(
  "keeps didactic tool arguments and results outside student presentation (failed=%s)",
  async (failed) => {
    const agent = new FixtureAgent();
    let privateRead = true;
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield {
        type: "tool-started",
        callId: "reused",
        name: privateRead ? "marea_read_skill" : "marea_read_project",
        arguments: { skillId: "private-evaluation", path: "SKILL.md" },
      };
      yield {
        type: "tool-started",
        callId: "public",
        name: "marea_read_project",
        arguments: { path: "exercise.txt" },
      };
      yield { type: "tool-finished", callId: "reused", failed, result: "PRIVATE RUBRIC OR ERROR" };
      yield { type: "tool-finished", callId: "public", failed: false, result: "Public exercise" };
      yield { type: "turn-completed" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");
    await fixture.controller.sendMessage("message:private", "Help", new AbortController().signal);
    const events = fixture.studentInterface.events;
    expect(events.filter((event) => event.type === "thinking")).toHaveLength(1);
    const visible = events.filter(
      (event) => event.type === "tool-started" || event.type === "tool-finished",
    );
    expect(visible.map((event) => event.callId)).toEqual(["public", "public"]);
    expect(JSON.stringify(events)).not.toMatch(
      /marea_read_skill|private-evaluation|SKILL\.md|PRIVATE RUBRIC/,
    );
    const boundary = events.length;
    privateRead = false;
    await fixture.controller.sendMessage(
      "message:public",
      "Read my file",
      new AbortController().signal,
    );
    expect(
      events
        .slice(boundary)
        .filter((event) => event.type === "tool-started" || event.type === "tool-finished")
        .map((event) => event.callId),
    ).toEqual(["reused", "public", "reused", "public"]);
  },
);

it("keeps private call identities across a resumed stream", async () => {
  const agent = approvalAgent();
  const approvalStream = agent.streamMessage.bind(agent);
  agent.streamMessage = async function* (...args) {
    yield {
      type: "tool-started",
      callId: "private:resume",
      name: "marea_read_skill",
      arguments: { path: "SKILL.md" },
    };
    yield* approvalStream(...args);
  };
  agent.resumeApproval = async function* () {
    await Promise.resolve();
    yield {
      type: "tool-finished",
      callId: "private:resume",
      failed: true,
      result: "PRIVATE resumed error",
    };
    yield { type: "turn-completed" };
  };
  const fixture = createFixtureController({ agent });
  await fixture.controller.start("Project One");
  await fixture.controller.sendMessage(
    "message:resume-private",
    "Help",
    new AbortController().signal,
  );
  expect(fixture.studentInterface.events.map((event) => event.type)).toEqual([
    "thinking",
    "turn-completed",
  ]);
});

it("allows another authorized write after recovering a stored approval", async () => {
  const agent = approvalAgent();
  let resumed = false;
  agent.resumeApproval = async function* () {
    await Promise.resolve();
    if (!resumed) {
      resumed = true;
      yield {
        type: "write-approval-required",
        approvalId: ApprovalIdSchema.parse("approval:after-recovery"),
        content: "Second",
        path: "second.txt",
        summary: "Write second file",
      };
    } else yield { type: "turn-completed" };
  };
  const fixture = createFixtureController({ agent });
  await fixture.controller.start("Project One");
  vi.spyOn(fixture.studentInterface, "confirmWrite").mockRejectedValueOnce(
    new ModelStreamError({
      code: "unavailable",
      message: "Synthetic interruption",
      retryable: true,
    }),
  );
  await expect(
    fixture.controller.sendMessage("message:recover", "Help", new AbortController().signal),
  ).rejects.toBeInstanceOf(TurnAttemptFailed);
  await fixture.controller.sendMessage("message:recover", "Help", new AbortController().signal);
  expect(fixture.studentInterface.prompts.map((prompt) => prompt.path)).toEqual([
    "notes.txt",
    "second.txt",
  ]);
  expect(await fixture.controller.pendingTurn()).toBeNull();
});
