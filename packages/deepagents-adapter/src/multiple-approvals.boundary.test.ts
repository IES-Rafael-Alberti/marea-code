import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import {
  approvalReviewId,
  assistantText,
  collect,
  MareaFakeModel,
  runtimeFor,
  signal,
} from "./adapter.fixture.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";

import { createInMemoryCheckpointForTest, createLocalCheckpoint } from "./checkpoint.boundary.js";
import { useTemporaryDirectories } from "./adapter.fixture.js";
import type { AgentEvent, ApprovalDecision, ApprovalTool } from "./contracts.js";
import { isCompletedGraphState } from "./recovery-state.boundary.js";

function commands() {
  const execute = vi.fn((input: Readonly<Record<string, string>>) =>
    Promise.resolve(`ran:${input.path ?? ""}`),
  );
  const tool: ApprovalTool = { name: "confirm_change", description: "Confirm a change", execute };
  return { execute, tool };
}

async function twoActions(
  decisions: readonly ApprovalDecision[],
  followUp = new AIMessage("Both handled."),
) {
  const checkpoint = createInMemoryCheckpointForTest();
  const { execute, tool } = commands();
  const first = new MareaFakeModel().respondWithTools([
    { name: "confirm_change", id: "change-a", args: { path: "a.txt" } },
    { name: "confirm_change", id: "change-b", args: { path: "b.txt" } },
  ]);
  const interrupted = await collect(
    runtimeFor(first, tool, checkpoint).streamMessage(
      { sessionId: "run:batch", messageId: "message:batch", text: "Change both." },
      signal(),
    ),
  );
  const resumedModel = new MareaFakeModel().respond(followUp);
  const resumed = await collect(
    runtimeFor(resumedModel, tool, checkpoint).resumeApproval(
      {
        sessionId: "run:batch",
        messageId: "message:batch",
        reviewId: approvalReviewId(interrupted),
        assistantText: assistantText(interrupted),
        decision: decisions[0] ?? { type: "approve" },
        decisions,
      },
      signal(),
    ),
  );
  const toolResults = (resumedModel.calls[0]?.messages ?? [])
    .filter((message) => ToolMessage.isInstance(message))
    .map((message) => [message.tool_call_id, message.content]);
  return { checkpoint, execute, interrupted, resumed, toolResults, tool };
}

const approval = (events: readonly AgentEvent[]) =>
  events.find((event) => event.type === "tool-approval-required");

describe("several approvals in one model message", () => {
  it("asks once with every action in call order and runs both when both are approved", async () => {
    const result = await twoActions([{ type: "approve" }, { type: "approve" }]);
    expect(approval(result.interrupted)).toMatchObject({
      toolName: "confirm_change",
      arguments: { path: "a.txt" },
      actions: [
        { index: 0, toolName: "confirm_change", arguments: { path: "a.txt" } },
        { index: 1, toolName: "confirm_change", arguments: { path: "b.txt" } },
      ],
    });
    expect(result.execute.mock.calls.map(([input]) => input.path)).toEqual(["a.txt", "b.txt"]);
    expect(result.resumed.at(-1)).toEqual({ type: "turn-completed" });
  });

  it("runs only the approved action and gives the model the reason for the rejected one", async () => {
    const result = await twoActions([
      { type: "approve" },
      { type: "reject", reason: "No toques b.txt todavía." },
    ]);
    expect(result.execute.mock.calls.map(([input]) => input.path)).toEqual(["a.txt"]);
    expect(result.toolResults).toEqual([
      ["change-a", "ran:a.txt"],
      ["change-b", "No toques b.txt todavía."],
    ]);
    expect(result.resumed.at(-1)).toEqual({ type: "turn-completed" });
  });

  it("rejects every action of an all-rejected batch without running any", async () => {
    const result = await twoActions([
      { type: "reject", reason: "No." },
      { type: "reject", reason: "Tampoco." },
    ]);
    expect(result.execute).not.toHaveBeenCalled();
    expect(result.toolResults.map(([, content]) => content)).toEqual(["No.", "Tampoco."]);
  });

  it("refuses a resume whose decisions do not cover every action", async () => {
    await expect(twoActions([{ type: "approve" }])).rejects.toMatchObject({
      code: "approval-review-mismatch",
      message: "Every pending action needs exactly one decision.",
    });
  });
});

const temporaryRoot = useTemporaryDirectories("marea-batch-");

function durableDirectories() {
  const root = temporaryRoot();
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  return { projectDirectory, storageDirectory: join(root, "state") };
}

describe("a batch across a restart", () => {
  it("recovers every action of a pending batch from the durable journal and resumes it", async () => {
    const { projectDirectory, storageDirectory } = durableDirectories();
    const { execute, tool } = commands();
    const first = new MareaFakeModel().respondWithTools([
      { name: "confirm_change", id: "change-a", args: { path: "a.txt" } },
      { name: "confirm_change", id: "change-b", args: { path: "b.txt" } },
    ]);
    const interrupted = await collect(
      runtimeFor(
        first,
        tool,
        createLocalCheckpoint({ projectDirectory, storageDirectory }),
      ).streamMessage(
        { sessionId: "run:durable", messageId: "message:durable", text: "Change both." },
        signal(),
      ),
    );
    const restarted = runtimeFor(
      new MareaFakeModel().respond(new AIMessage("Done.")),
      tool,
      createLocalCheckpoint({ projectDirectory, storageDirectory }),
    );
    const recovered = await restarted.recoverMessage({
      sessionId: "run:durable",
      messageId: "message:durable",
      assistantText: assistantText(interrupted),
    });
    expect(recovered?.type).toBe("pending-approval");
    expect(approval(recovered?.events ?? [])).toMatchObject({
      actions: [{ arguments: { path: "a.txt" } }, { arguments: { path: "b.txt" } }],
    });
    const resumed = await collect(
      restarted.resumeApproval(
        {
          sessionId: "run:durable",
          messageId: "message:durable",
          reviewId: approvalReviewId(interrupted),
          assistantText: assistantText(interrupted),
          decision: { type: "approve" },
          decisions: [{ type: "approve" }, { type: "reject", reason: "Solo a.txt." }],
        },
        signal(),
      ),
    );
    expect(execute.mock.calls.map(([input]) => input.path)).toEqual(["a.txt"]);
    expect(resumed.at(-1)).toEqual({ type: "turn-completed" });
  });
});

/** Rewrites the stored journal as preview 43 wrote it: approvals without their action list. */
function asPreview43Journal(storageDirectory: string): void {
  const path = join(storageDirectory, "checkpoints.bin");
  const state = deserialize(readFileSync(path)) as {
    turns: Record<string, { events: Record<string, object>[] }>;
  };
  for (const turn of Object.values(state.turns))
    for (const event of turn.events) Reflect.deleteProperty(event, "actions");
  writeFileSync(path, serialize(state));
}

function journaledApprovals(storageDirectory: string): readonly object[] {
  const state = deserialize(readFileSync(join(storageDirectory, "checkpoints.bin"))) as {
    turns: Record<string, { events: { type: string }[] }>;
  };
  return Object.values(state.turns).flatMap((turn) =>
    turn.events.filter((event) => event.type === "tool-approval-required"),
  );
}

describe("an approval saved by preview 43", () => {
  it("still resumes, read as a batch of one action", async () => {
    const { projectDirectory, storageDirectory } = durableDirectories();
    const { execute, tool } = commands();
    const first = new MareaFakeModel().respondWithTools([
      { name: "confirm_change", id: "change-a", args: { path: "a.txt" } },
    ]);
    const interrupted = await collect(
      runtimeFor(
        first,
        tool,
        createLocalCheckpoint({ projectDirectory, storageDirectory }),
      ).streamMessage(
        { sessionId: "run:legacy", messageId: "message:legacy", text: "Change it." },
        signal(),
      ),
    );
    asPreview43Journal(storageDirectory);
    const restarted = runtimeFor(
      new MareaFakeModel().respond(new AIMessage("Done.")),
      tool,
      createLocalCheckpoint({ projectDirectory, storageDirectory }),
    );
    const resumed = await collect(
      restarted.resumeApproval(
        {
          sessionId: "run:legacy",
          messageId: "message:legacy",
          reviewId: approvalReviewId(interrupted),
          assistantText: assistantText(interrupted),
          decision: { type: "approve" },
        },
        signal(),
      ),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(resumed.at(-1)).toEqual({ type: "turn-completed" });
    // The completed turn journals the approval again, now as a batch of one action.
    const original = approval(interrupted);
    expect(journaledApprovals(storageDirectory)).toEqual([
      expect.objectContaining({
        actions: [
          {
            index: 0,
            toolName: original?.toolName,
            arguments: original?.arguments,
            description: original?.description,
          },
        ],
      }),
    ]);
  });
});

describe("checkpoints this adapter cannot interpret", () => {
  it("treats a pending interrupt of an unknown shape as not completed instead of failing", () => {
    expect(
      isCompletedGraphState({
        values: {},
        next: ["tools"],
        tasks: [{ interrupts: [{ id: "x", value: { unexpected: true } }] }],
      }),
    ).toBe(false);
    expect(isCompletedGraphState({ values: {}, next: [], tasks: [] })).toBe(true);
  });
});
