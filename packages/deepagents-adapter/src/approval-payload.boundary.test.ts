import { describe, expect, it } from "vitest";

import { assertRecoveredReview } from "./approval-state.boundary.js";
import { AgentAdapterError } from "./contracts.js";
import {
  assertPendingReview,
  diagnosticCauseFor,
  normalizeDiagnosticCause,
  parseApprovalEvent,
} from "./upstream.boundary.js";

function approvalEnvelope(overrides?: {
  readonly interrupts?: number;
  readonly requests?: number;
  readonly reviews?: number;
  readonly requestName?: string;
  readonly reviewName?: string;
  readonly decisions?: readonly ("approve" | "edit" | "reject")[];
}) {
  const request = {
    name: overrides?.requestName ?? "confirm_change",
    args: { path: "src/example.ts" },
    description: "Review the synthetic change",
  };
  const review = {
    actionName: overrides?.reviewName ?? "confirm_change",
    allowedDecisions: overrides?.decisions ?? ["approve", "edit", "reject"],
  };
  const interrupt = {
    id: "review-1",
    value: {
      actionRequests: Array.from({ length: overrides?.requests ?? 1 }, () => request),
      reviewConfigs: Array.from({ length: overrides?.reviews ?? 1 }, () => review),
    },
  };
  return {
    __interrupt__: Array.from({ length: overrides?.interrupts ?? 1 }, () => interrupt),
  };
}

function pendingState(overrides?: Parameters<typeof approvalEnvelope>[0]) {
  return {
    metadata: { messageId: "message:1" },
    tasks: [{ interrupts: approvalEnvelope(overrides).__interrupt__ }],
  };
}

describe("HITL payload parser", () => {
  it("returns null when a completed output has no interrupt", () => {
    expect(parseApprovalEvent({ messages: [] })).toBeNull();
  });

  const action = (index: number) => ({
    index,
    toolName: "confirm_change",
    arguments: { path: "src/example.ts" },
    description: "Review the synthetic change",
  });

  it("copies a single-action interrupt", () => {
    expect(parseApprovalEvent(approvalEnvelope())).toEqual({
      type: "tool-approval-required",
      reviewId: "review-1",
      toolName: "confirm_change",
      arguments: { path: "src/example.ts" },
      description: "Review the synthetic change",
      allowedDecisions: ["approve", "amend", "reject"],
      actions: [action(0)],
    });
  });

  it.each([
    ["several requests reviewed by one configuration", { requests: 3 }, 3],
    ["one review configuration per request", { requests: 2, reviews: 2 }, 2],
    ["decisions that include approve and reject", { decisions: ["reject", "approve"] }, 1],
    ["extra decisions", { decisions: ["approve", "edit", "reject", "reject"] }, 1],
  ] as const)("accepts %s", (_label, overrides, count) => {
    const event = parseApprovalEvent(approvalEnvelope(overrides));
    expect(event).toMatchObject({ toolName: "confirm_change", reviewId: "review-1" });
    expect(event?.type === "tool-approval-required" ? event.actions : []).toEqual(
      Array.from({ length: count }, (_, index) => action(index)),
    );
  });

  it("pairs each request with the review of its own tool, whatever the order", () => {
    const event = parseApprovalEvent({
      __interrupt__: [
        {
          id: "review-2",
          value: {
            actionRequests: [
              { name: "marea_execute", args: { command: "dir" }, description: "Run dir" },
              { name: "marea_delete", args: { path: "a.txt" }, description: "Delete a.txt" },
            ],
            reviewConfigs: [
              { actionName: "marea_delete", allowedDecisions: ["approve", "reject"] },
              { actionName: "marea_execute", allowedDecisions: ["approve", "edit", "reject"] },
            ],
          },
        },
      ],
    });
    expect(event?.type === "tool-approval-required" ? event.actions : []).toEqual([
      {
        index: 0,
        toolName: "marea_execute",
        arguments: { command: "dir" },
        description: "Run dir",
      },
      {
        index: 1,
        toolName: "marea_delete",
        arguments: { path: "a.txt" },
        description: "Delete a.txt",
      },
    ]);
  });

  it.each([
    ["an invalid envelope", { __interrupt__: "invalid" }],
    ["no interrupt", approvalEnvelope({ interrupts: 0 })],
    ["multiple interrupts", approvalEnvelope({ interrupts: 2 })],
    ["no request", approvalEnvelope({ requests: 0 })],
    ["no review", approvalEnvelope({ reviews: 0 })],
    ["different action names", approvalEnvelope({ reviewName: "different_tool" })],
    ["no reject decision", approvalEnvelope({ decisions: ["approve"] })],
    ["no approve decision", approvalEnvelope({ decisions: ["edit", "edit", "reject"] })],
    [
      "an unknown decision",
      approvalEnvelope({ decisions: ["approve", "ignore" as "edit", "reject"] }),
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseApprovalEvent(value)).toThrow(
      expect.objectContaining({
        code: "upstream-contract-changed",
        message: "DeepAgents returned an unsupported approval payload.",
      }),
    );
  });

  it("preserves an adapter error identity", () => {
    const error = new AgentAdapterError("upstream-contract-changed", "synthetic");
    expect(error).toMatchObject({
      name: "AgentAdapterError",
      code: "upstream-contract-changed",
      message: "synthetic",
    });
  });
});

describe("pending review parser", () => {
  it("accepts the exact single pending review", () => {
    expect(() => {
      assertPendingReview(pendingState(), "review-1", "confirm_change", "message:1");
    }).not.toThrow();
  });

  it("rejects a state without a pending review", () => {
    expect(() => {
      assertPendingReview({ tasks: [] }, "missing-review", "confirm_change", "message:1");
    }).toThrow(
      expect.objectContaining({
        code: "approval-not-pending",
        message: "No tool approval is pending for this session.",
      }),
    );
  });

  it("rejects a stale review id", () => {
    expect(() => {
      assertPendingReview(pendingState(), "stale-review", "confirm_change", "message:1");
    }).toThrow(
      expect.objectContaining({
        code: "approval-review-mismatch",
        message: "The pending tool approval does not match this review.",
      }),
    );
  });

  it.each([
    ["an invalid state", {}],
    [
      "an interrupt without an id",
      {
        tasks: [
          {
            interrupts: [
              {
                value: approvalEnvelope().__interrupt__[0]?.value,
              },
            ],
          },
        ],
      },
    ],
    ["multiple pending reviews", pendingState({ interrupts: 2 })],
    ["different action names", pendingState({ reviewName: "different_tool" })],
    ["an unsupported review config", pendingState({ decisions: ["approve"] })],
  ])("rejects %s as an upstream contract change", (_label, state) => {
    expect(() => {
      assertPendingReview(state, "review-1", "confirm_change", "message:1");
    }).toThrow(expect.objectContaining({ code: "upstream-contract-changed" }));
  });

  it("rejects a pending action owned by another configured tool", () => {
    expect(() => {
      assertPendingReview(pendingState(), "review-1", "other_change", "message:1");
    }).toThrow(expect.objectContaining({ code: "upstream-contract-changed" }));
  });

  it.each([undefined, null, "invalid", {}, { messageId: "message:other" }])(
    "rejects invalid message metadata %j",
    (metadata) => {
      expect(() => {
        assertPendingReview(
          { ...pendingState(), metadata },
          "review-1",
          "confirm_change",
          "message:1",
        );
      }).toThrow(
        expect.objectContaining({
          code: "approval-message-mismatch",
          message: "The pending tool approval does not match this message.",
        }),
      );
    },
  );
});

describe("recovered review parser", () => {
  const approval = {
    type: "tool-approval-required" as const,
    reviewId: "review-1",
    toolName: "confirm_change",
    arguments: { path: "src/example.ts" },
    description: "Review the synthetic change",
    allowedDecisions: ["approve", "amend", "reject"] as const,
    actions: [
      {
        index: 0,
        toolName: "confirm_change",
        arguments: { path: "src/example.ts" },
        description: "Review the synthetic change",
      },
    ],
  };

  it("accepts the exact recovered review", () => {
    expect(() => {
      assertRecoveredReview({ approval }, "review-1", "confirm_change");
    }).not.toThrow();
  });

  it("rejects an in-progress turn without its original approval", () => {
    expect(() => {
      assertRecoveredReview({ approval: null }, "review-1", "confirm_change");
    }).toThrow(
      expect.objectContaining({
        code: "approval-not-pending",
        message: "No tool approval is pending for this session.",
      }),
    );
  });

  it("rejects a different recovered review or tool", () => {
    expect(() => {
      assertRecoveredReview({ approval }, "review:other", "confirm_change");
    }).toThrow(
      expect.objectContaining({
        code: "approval-review-mismatch",
        message: "The pending tool approval does not match this review.",
      }),
    );
    expect(() => {
      assertRecoveredReview({ approval }, "review-1", "other_change");
    }).toThrow(expect.objectContaining({ code: "upstream-contract-changed" }));
  });
});

describe("private diagnostics", () => {
  it("normalizes a non-Error cause without retaining the thrown data", () => {
    expect(normalizeDiagnosticCause({ secret: "not retained" })).toEqual({
      name: "NonErrorThrownValue",
      message: "The upstream runtime threw a non-Error value.",
    });
    expect(
      diagnosticCauseFor(new AgentAdapterError("upstream-execution-failed", "unregistered")),
    ).toBeNull();
  });
});
