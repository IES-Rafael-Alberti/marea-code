import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAgentCheckpoint,
  createLocalCheckpoint,
  createMareaGatewayModel,
  type AgentEvent as DeepAgentEvent,
} from "@marea/deepagents-adapter";
import { ApprovalIdSchema, RequestIdSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";
import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import {
  checkpoint,
  model,
  runId,
  approvalId,
  effect,
  snapshot,
  message,
  approval,
  collect,
  approvalRequired,
  harness,
  DurableApprovalGateway,
  type PersistedApprovalTurn,
} from "./deepagents-runtime.fixture.js";

describe("DeepAgents student runtime bridge", () => {
  it("rejects incomplete persisted approval context before creating a runtime", () => {
    for (const field of ["content", "path", "snapshot", "summary"]) {
      const instance = harness();
      const turn = approval("approved", effect);
      Reflect.deleteProperty(turn, field);
      expect(() => instance.runtime.resumeApproval(turn, new AbortController().signal)).toThrow(
        "The persisted approval context is incomplete.",
      );
      expect(instance.options).toHaveLength(0);
    }
  });

  it("rejects persisted approval details that differ from the durable review", async () => {
    for (const field of ["content", "path", "summary"] as const) {
      const instance = harness();
      await collect(instance.runtime.streamMessage(message(), new AbortController().signal));
      const turn = { ...approval("approved", effect), [field]: "changed" };
      await expect(
        collect(instance.runtime.resumeApproval(turn, new AbortController().signal)),
      ).rejects.toThrow("The persisted approval does not match DeepAgents state.");
      expect(instance.deep.resumes).toHaveLength(0);
    }
  });

  it("rejects a changed snapshot when resuming an existing runtime", async () => {
    const instance = harness();
    await collect(instance.runtime.streamMessage(message(), new AbortController().signal));
    expect(() =>
      instance.runtime.resumeApproval(
        { ...approval("approved", effect), snapshot: snapshot("snapshot:changed") },
        new AbortController().signal,
      ),
    ).toThrow("An active run cannot change its immutable snapshot.");
    expect(instance.deep.resumes).toHaveLength(0);
  });

  it("builds one snapshot-bound runtime and translates messages and HITL approval", async () => {
    const { deep, options, runtime } = harness();
    const events = await collect(runtime.streamMessage(message(), new AbortController().signal));

    expect(events).toEqual([
      { type: "assistant-text-delta", text: "Thinking" },
      {
        type: "write-approval-required",
        approvalId,
        path: "notes.txt",
        content: "content",
        summary: "Create notes.",
      },
    ]);
    expect(deep.messageTurns).toEqual([
      { assistantText: "", messageId: "message:1", sessionId: runId, text: "Help me" },
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ checkpoint, model, systemPrompt: "Teach clearly." });
    expect(options[0]?.approvalTool.name).toBe("marea_write_file");
    expect(options[0]?.approvalTool.description).toContain("approved");

    deep.messages = [{ type: "turn-cancelled" }];
    await expect(
      collect(
        runtime.streamMessage(
          { ...message(), messageId: "message:2" },
          new AbortController().signal,
        ),
      ),
    ).resolves.toEqual([{ type: "turn-cancelled" }]);
    expect(options).toHaveLength(1);
    expect(deep.messageTurns).toHaveLength(2);
  });

  it("passes only a pre-applied approved result through the controlled tool", async () => {
    const { deep, runtime } = harness();
    await collect(runtime.streamMessage(message(), new AbortController().signal));
    const result = await collect(
      runtime.resumeApproval(approval("approved", effect), new AbortController().signal),
    );

    expect(result).toEqual([{ type: "turn-completed" }]);
    expect(deep.resumes).toEqual([
      {
        assistantText: "Thinking",
        messageId: "message:1",
        sessionId: runId,
        reviewId: approvalId,
        decision: { type: "approve" },
      },
    ]);
    expect(JSON.parse(deep.toolResult ?? "null")).toEqual(effect);
    await expect(
      deep.executeTool?.execute({ path: "notes.txt", content: "content" }),
    ).rejects.toThrow("DeepAgents attempted a workspace write that was not approved.");
    deep.messages = [{ type: "turn-completed" }];
    await expect(
      collect(runtime.streamMessage(message(), new AbortController().signal)),
    ).resolves.toEqual([{ type: "turn-completed" }]);
  });

  it("maps rejection without exposing a workspace effect", async () => {
    const { deep, runtime } = harness();
    await collect(runtime.streamMessage(message(), new AbortController().signal));
    await expect(
      collect(runtime.resumeApproval(approval("rejected", null), new AbortController().signal)),
    ).resolves.toEqual([{ type: "turn-completed" }]);
    expect(deep.resumes[0]?.decision).toEqual({
      type: "reject",
      reason: "The student rejected the workspace edit.",
    });
  });

  it("replays a still-pending approval and restores it after a failed resume", async () => {
    const { deep, runtime } = harness();
    const first = await collect(runtime.streamMessage(message(), new AbortController().signal));
    const replay = await collect(runtime.streamMessage(message(), new AbortController().signal));
    expect(replay).toEqual(first.slice(1));
    expect(deep.messageTurns).toHaveLength(1);

    deep.failResume = true;
    await expect(
      collect(runtime.resumeApproval(approval("approved", effect), new AbortController().signal)),
    ).rejects.toThrow("resume failed");
    await expect(
      deep.executeTool?.execute({ path: "notes.txt", content: "content" }),
    ).rejects.toThrow("DeepAgents attempted a workspace write that was not approved.");
    await expect(
      collect(runtime.streamMessage(message(), new AbortController().signal)),
    ).resolves.toEqual(first.slice(1));
  });

  it("reconstructs its snapshot-bound runtime from a real durable DeepAgents approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "marea-student-deepagents-"));
    const projectDirectory = join(root, "project");
    const storageDirectory = join(root, "runtime-state");
    mkdirSync(projectDirectory);
    const gateway = new DurableApprovalGateway();
    let requestSequence = 0;
    const gatewayModel = createMareaGatewayModel({
      gateway,
      nextRequestId: () => RequestIdSchema.parse(`request-${String(++requestSequence)}`),
    });
    const snapshotValue = snapshot();
    let openCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    try {
      const firstRuntime = createDeepAgentsStudentRuntime({
        checkpoint: openCheckpoint,
        model: gatewayModel,
      });
      const firstEvents = await collect(
        firstRuntime.streamMessage(message(snapshotValue), new AbortController().signal),
      );
      const pending = firstEvents.find((event) => event.type === "write-approval-required");
      if (pending?.type !== "write-approval-required") {
        throw new Error("Expected a durable write approval.");
      }
      const persistedAssistantText = firstEvents
        .filter((event) => event.type === "assistant-text-delta")
        .map((event) => event.text)
        .join("");
      closeAgentCheckpoint(openCheckpoint);
      openCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
      const restartedRuntime = createDeepAgentsStudentRuntime({
        checkpoint: openCheckpoint,
        model: gatewayModel,
      });
      const persistedTurn = {
        approvalId: pending.approvalId,
        assistantText: persistedAssistantText,
        content: pending.content,
        decision: "approved" as const,
        effect,
        messageId: "message:1",
        path: pending.path,
        runId,
        snapshot: snapshotValue,
        summary: pending.summary,
      } satisfies PersistedApprovalTurn;

      const resumed = await collect(
        restartedRuntime.resumeApproval(persistedTurn, new AbortController().signal),
      );
      const started = resumed.find((event) => event.type === "tool-started");
      const finished = resumed.find((event) => event.type === "tool-finished");
      if (started?.type !== "tool-started" || finished?.type !== "tool-finished") {
        throw new Error("Expected paired tool call events.");
      }
      expect(started.callId).toBe(finished.callId);
      expect(resumed).toMatchObject([
        {
          arguments: { content: pending.content, path: pending.path },
          callId: started.callId,
          name: "marea_write_file",
          type: "tool-started",
        },
        {
          callId: finished.callId,
          failed: false,
          result: JSON.stringify(effect),
          type: "tool-finished",
        },
        { type: "assistant-text-delta", text: "saved" },
        { type: "turn-completed" },
      ]);
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[0]?.tools.filter((tool) => tool.name === "write_file")).toHaveLength(
        1,
      );
    } finally {
      closeAgentCheckpoint(openCheckpoint);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects denied policies, changed snapshots, unsupported tools, and malformed writes", async () => {
    const denied = harness().runtime;
    expect(() =>
      denied.streamMessage(
        message(snapshot("snapshot:deny", "deny")),
        new AbortController().signal,
      ),
    ).toThrow("The run snapshot denies workspace writes.");

    const changed = harness().runtime;
    await collect(
      changed.streamMessage(message(snapshot("snapshot:1", null)), new AbortController().signal),
    );
    expect(() =>
      changed.streamMessage(message(snapshot("snapshot:2")), new AbortController().signal),
    ).toThrow("An active run cannot change its immutable snapshot.");

    const invalidEvents: readonly (readonly [DeepAgentEvent, string])[] = [
      [approvalRequired({ toolName: "shell" }), "DeepAgents requested an unsupported tool."],
      [approvalRequired({ toolName: "write_file" }), "DeepAgents requested an unsupported tool."],
      [
        approvalRequired({ arguments: { path: "notes.txt" } }),
        "DeepAgents returned invalid write_file arguments.",
      ],
      [
        approvalRequired({ arguments: { content: "content" } }),
        "DeepAgents returned invalid write_file arguments.",
      ],
      [
        approvalRequired({ arguments: { path: "", content: "content" } }),
        "DeepAgents returned invalid write_file arguments.",
      ],
    ];
    for (const [event, expectedMessage] of invalidEvents) {
      const instance = harness();
      instance.deep.messages = [event];
      await expect(
        collect(instance.runtime.streamMessage(message(), new AbortController().signal)),
      ).rejects.toThrow(expectedMessage);
    }
    const invalidReview = harness();
    invalidReview.deep.messages = [approvalRequired({ reviewId: "invalid approval" })];
    await expect(
      collect(invalidReview.runtime.streamMessage(message(), new AbortController().signal)),
    ).rejects.toThrow("DeepAgents returned an invalid approval identity.");

    const base = snapshot("snapshot:other-policy", null);
    const unrelatedDeny = {
      ...base,
      teacherToolPolicy: {
        ...base.teacherToolPolicy,
        restrictions: [{ tool: "shell", effect: "deny" as const }],
      },
    };
    await expect(
      collect(
        harness().runtime.streamMessage(message(unrelatedDeny), new AbortController().signal),
      ),
    ).resolves.toEqual(expect.any(Array));
  });

  it("rejects duplicate approvals and invalid approval continuations", async () => {
    const missing = harness().runtime;
    await expect(
      collect(missing.resumeApproval(approval("approved", effect), new AbortController().signal)),
    ).rejects.toThrow("The DeepAgents approval is not pending for this message.");

    const instance = harness();
    instance.deep.messages = [approvalRequired(), approvalRequired()];
    await expect(
      collect(instance.runtime.streamMessage(message(), new AbortController().signal)),
    ).rejects.toThrow("DeepAgents repeated a pending approval.");

    const invalid = harness();
    await collect(invalid.runtime.streamMessage(message(), new AbortController().signal));
    await expect(
      collect(
        invalid.runtime.resumeApproval(
          { ...approval("approved", effect), approvalId: ApprovalIdSchema.parse("approval:other") },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("The DeepAgents approval is not pending for this message.");
    await expect(
      collect(
        invalid.runtime.resumeApproval(
          approval("approved", effect, "message:other"),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("The DeepAgents approval is not pending for this message.");
    const wrongTool = harness();
    await collect(wrongTool.runtime.streamMessage(message(), new AbortController().signal));
    wrongTool.deep.messages = [
      { type: "assistant-text-delta", text: "Thinking" },
      approvalRequired({ toolName: "shell" }),
    ];
    await expect(
      collect(
        wrongTool.runtime.resumeApproval(
          approval("approved", effect),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("The DeepAgents approval is not pending for this message.");
    expect(() =>
      invalid.runtime.resumeApproval(approval("approved", null), new AbortController().signal),
    ).toThrow("An approved write requires its durable effect.");
    expect(() =>
      invalid.runtime.resumeApproval(approval("rejected", effect), new AbortController().signal),
    ).toThrow("A rejected write cannot include an effect.");
  });

  it("rejects controlled tool argument mismatches", async () => {
    const invalidArguments: readonly (readonly [Readonly<Record<string, string>>, string])[] = [
      [
        { path: "notes.txt", content: "different" },
        "DeepAgents attempted a workspace write that was not approved.",
      ],
      [{ path: "", content: "content" }, "DeepAgents returned invalid write_file arguments."],
      [
        { path: "notes.txt", content: "content", extra: "value" },
        "DeepAgents returned invalid write_file arguments.",
      ],
    ];
    for (const [arguments_, expectedMessage] of invalidArguments) {
      const instance = harness();
      instance.deep.toolArguments = arguments_;
      await collect(instance.runtime.streamMessage(message(), new AbortController().signal));
      await expect(
        collect(
          instance.runtime.resumeApproval(
            approval("approved", effect),
            new AbortController().signal,
          ),
        ),
      ).rejects.toThrow(expectedMessage);
    }
  });
});

it("adds project facts after the immutable teaching prompt without rewriting its snapshot", async () => {
  const instance = harness();
  const teaching = snapshot();
  let prompt = "";
  const runtime = createDeepAgentsStudentRuntime({
    checkpoint,
    model,
    projectContext: (selected) => {
      expect(selected).toBe(teaching);
      return "Synthetic initial project facts";
    },
    createRuntime: (options) => {
      prompt = options.systemPrompt;
      return instance.deep;
    },
  });
  await collect(
    runtime.streamMessage({ ...message(), snapshot: teaching }, new AbortController().signal),
  );
  expect(prompt).toBe("Teach clearly.\n\nSynthetic initial project facts");
  expect(teaching.prompt.content).toBe("Teach clearly.");
});
