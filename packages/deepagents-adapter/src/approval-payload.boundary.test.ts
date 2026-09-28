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

  it("copies the supported single-action interrupt", () => {
    expect(parseApprovalEvent(approvalEnvelope())).toEqual({
      type: "tool-approval-required",
      reviewId: "review-1",
      toolName: "confirm_change",
      arguments: { path: "src/example.ts" },
      description: "Review the synthetic change",
      allowedDecisions: ["approve", "amend", "reject"],
    });
  });

  it.each([
    ["an invalid envelope", { __interrupt__: "invalid" }],
    ["no interrupt", approvalEnvelope({ interrupts: 0 })],
    ["multiple interrupts", approvalEnvelope({ interrupts: 2 })],
    ["no request", approvalEnvelope({ requests: 0 })],
    ["multiple requests", approvalEnvelope({ requests: 2 })],
    ["no review", approvalEnvelope({ reviews: 0 })],
    ["multiple reviews", approvalEnvelope({ reviews: 2 })],
    ["different action names", approvalEnvelope({ reviewName: "different_tool" })],
    ["one decision", approvalEnvelope({ decisions: ["approve"] })],
    ["two decisions", approvalEnvelope({ decisions: ["approve", "reject"] })],
    ["a non-approve first decision", approvalEnvelope({ decisions: ["edit", "edit", "reject"] })],
    [
      "a non-edit second decision",
      approvalEnvelope({ decisions: ["approve", "approve", "reject"] }),
    ],
    ["a non-reject third decision", approvalEnvelope({ decisions: ["approve", "edit", "edit"] })],
    ["four decisions", approvalEnvelope({ decisions: ["approve", "edit", "reject", "reject"] })],
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
