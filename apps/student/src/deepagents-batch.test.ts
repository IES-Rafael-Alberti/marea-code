import { describe, expect, it, vi } from "vitest";

import { approvalRequired, batchApprovalRequired, snapshot } from "./deepagents-runtime.fixture.js";
import { batchApprovalId, batchDecisions, batchEventFor } from "./deepagents-batch.js";
import type { AgentBatchTurn, BatchAction, BatchDecision, WorkspaceWrite } from "./contracts.js";
import { OperationMediator } from "./operation-mediator.js";
import { StudentAgentBridgeError } from "./bridge-parsing.js";
import { RunIdSchema, Sha256DigestSchema } from "@marea/protocol";

const execute = new OperationMediator("execute", "linux");
const remove = new OperationMediator("delete", "linux");
const writes = { authorize: vi.fn() };
const mediators = { operations: [remove, execute], writes };

const event = batchApprovalRequired("review-7", [
  {
    toolName: "marea_write_file",
    arguments: { path: "notes.txt", content: "hola" },
    description: "Write notes",
  },
  {
    toolName: "marea_ask_user",
    arguments: {
      questions: JSON.stringify([{ text: "¿Lista o diccionario?", choices: [], required: true }]),
    },
    description: "Ask",
  },
]);

function turn(
  decisions: readonly BatchDecision[],
  actions?: readonly BatchAction[],
): AgentBatchTurn {
  const batch = batchEventFor(event, mediators);
  if (batch.type !== "approval-batch-required") throw new Error("expected a batch");
  return {
    runId: RunIdSchema.parse("run:batch"),
    snapshot: snapshot(),
    messageId: "message:batch",
    reviewId: "review-7",
    actions: actions ?? batch.actions,
    decisions,
  };
}

const effect: WorkspaceWrite = {
  digest: Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`),
  operation: "created",
  path: "notes.txt",
};

describe("DeepAgents batch translation", () => {
  it("gives each action its own identity and routes it by tool", () => {
    expect(batchEventFor(event, mediators)).toMatchObject({
      type: "approval-batch-required",
      reviewId: "review-7",
      actions: [
        {
          index: 0,
          kind: "operation",
          request: {
            approvalId: "review-7:batch-0",
            tool: "execute",
            arguments: { command: "dir" },
          },
        },
        {
          index: 1,
          kind: "write",
          approvalId: "review-7:batch-1",
          path: "notes.txt",
          content: "hola",
        },
        { index: 2, kind: "questions", request: { interruptId: "review-7:batch-2" } },
      ],
    });
    expect(batchApprovalId("r", 3)).toBe("r:batch-3");
  });

  it("refuses a tool Marea does not mediate", () => {
    expect(() =>
      batchEventFor(
        approvalRequired({
          actions: [
            { index: 0, toolName: "marea_execute", arguments: { command: "x" }, description: "x" },
            { index: 1, toolName: "other_tool", arguments: {}, description: "x" },
          ],
        }),
        mediators,
      ),
    ).toThrow("unsupported tool");
  });

  it("authorizes approved effects and maps every decision in order", async () => {
    const result = batchDecisions(
      turn([
        { kind: "operation", decision: "approved", result: "listing" },
        { kind: "write", decision: "approved", effect },
        { kind: "questions", values: ["Lista"] },
      ]),
      mediators,
    );
    expect(result.toolName).toBe("marea_execute");
    expect(result.decisions).toEqual([
      { type: "approve" },
      { type: "approve" },
      {
        type: "amend",
        arguments: {
          questions: JSON.stringify([
            { text: "¿Lista o diccionario?", choices: [], required: true },
          ]),
          answers: JSON.stringify(["Lista"]),
        },
      },
    ]);
    await expect(execute.execute({ command: "dir" })).resolves.toBe("listing");
    expect(writes.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ path: "notes.txt", content: "hola" }),
      effect,
    );
  });

  it("sends rejections with the student's reason or a default", () => {
    const result = batchDecisions(
      turn([
        { kind: "operation", decision: "rejected", reason: "No.", result: null },
        { kind: "write", decision: "rejected", effect: null },
        { kind: "questions", values: ["Lista"] },
      ]),
      mediators,
    );
    expect(result.decisions.slice(0, 2)).toEqual([
      { type: "reject", reason: "No." },
      { type: "reject", reason: "The student rejected this action." },
    ]);
    const blank = batchDecisions(
      turn([
        { kind: "operation", decision: "rejected", reason: "", result: null },
        { kind: "write", decision: "rejected", reason: " ", effect: null },
        { kind: "questions", values: ["Lista"] },
      ]),
      mediators,
    );
    expect(blank.decisions.slice(0, 2)).toEqual([
      { type: "reject", reason: "The student rejected this action." },
      { type: "reject", reason: "The student rejected this action." },
    ]);
    // The first decision also travels on its own for the upstream resume.
    expect(result.decision).toBe(result.decisions[0]);
  });

  it.each([
    [[{ kind: "operation", decision: "approved", result: "x" }], "exactly one decision"],
    [
      [
        { kind: "operation", decision: "approved", result: "x" },
        { kind: "write", decision: "approved", effect },
        { kind: "questions", values: [] },
        { kind: "questions", values: [] },
      ],
      "exactly one decision",
    ],
    [
      [
        { kind: "write", decision: "approved", effect },
        { kind: "write", decision: "approved", effect },
        { kind: "questions", values: [] },
      ],
      "does not match",
    ],
    [
      [
        { kind: "operation", decision: "approved", result: "x" },
        { kind: "write", decision: "approved", effect },
        { kind: "operation", decision: "approved", result: "x" },
      ],
      "does not match",
    ],
    [
      [
        { kind: "operation", decision: "approved", result: null },
        { kind: "write", decision: "approved", effect },
        { kind: "questions", values: [] },
      ],
      "no recorded result",
    ],
    [
      [
        { kind: "operation", decision: "approved", result: "x" },
        { kind: "write", decision: "approved", effect: null },
        { kind: "questions", values: [] },
      ],
      "no recorded effect",
    ],
  ] as const)("refuses inconsistent decisions %#", (decisions, message) => {
    const refused = () => batchDecisions(turn(decisions), mediators);
    expect(refused).toThrow(StudentAgentBridgeError);
    expect(refused).toThrow(message);
  });

  it("names the upstream tool after the first action, whatever its kind", () => {
    const batch = batchEventFor(event, mediators);
    if (batch.type !== "approval-batch-required") throw new Error("expected a batch");
    const [operation, write, questions] = batch.actions as [BatchAction, BatchAction, BatchAction];
    expect(
      batchDecisions(
        turn(
          [
            { kind: "write", decision: "rejected", effect: null },
            { kind: "operation", decision: "rejected", result: null },
          ],
          [write, operation],
        ),
        mediators,
      ).toolName,
    ).toBe("marea_write_file");
    expect(
      batchDecisions(
        turn(
          [
            { kind: "questions", values: ["Lista"] },
            { kind: "operation", decision: "rejected", result: null },
          ],
          [questions, operation],
        ),
        mediators,
      ).toolName,
    ).toBe("marea_ask_user");
  });

  it("refuses an empty batch and an operation without its mediator", () => {
    expect(() => batchDecisions(turn([], []), mediators)).toThrow("no actions");
    const deleteAction: BatchAction = {
      index: 0,
      kind: "operation",
      request: {
        approvalId: batchApprovalId("r", 0),
        tool: "delete",
        arguments: { path: "a" },
        summary: "Delete",
      },
    };
    const executeOnly = { operations: [execute], writes };
    for (const decision of [
      { kind: "operation", decision: "approved", result: "x" },
      { kind: "operation", decision: "rejected", result: null },
    ] as const)
      expect(() => batchDecisions(turn([decision], [deleteAction]), executeOnly)).toThrow(
        "unavailable",
      );
  });
});
