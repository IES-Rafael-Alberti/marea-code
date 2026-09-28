import { AgentAdapterError, ModelStreamError } from "@marea/deepagents-adapter";
import { describe, expect, it } from "vitest";

import { NoActiveRunError, StoredTurnFailure, TurnAttemptFailed } from "./contracts.js";
import { StudentHttpError } from "./http-client.boundary.js";
import { attemptFailure, classifyTurnFailure } from "./turn-failure.boundary.js";

function streamFailure(overrides?: {
  readonly code?: string;
  readonly message?: string;
  readonly retryable?: boolean;
}) {
  return new ModelStreamError({
    code: overrides?.code ?? "unavailable",
    message: overrides?.message ?? "The request exceeds the configured inference limits.",
    retryable: overrides?.retryable ?? false,
  });
}

describe("classifyTurnFailure", () => {
  it("wraps stream failures with their prefix and a safe cause", () => {
    const wrapped = attemptFailure("Saved prefix", new Error("connection lost"));
    expect(wrapped).toBeInstanceOf(TurnAttemptFailed);
    expect(wrapped.prefix).toBe("Saved prefix");
    expect(wrapped.cause.message).toBe("connection lost");
    const normalized = attemptFailure("", "synthetic string failure");
    expect(normalized.cause.message).toBe("The agent stream threw an unexpected value.");
  });
  it("names its carrier errors", () => {
    expect(new NoActiveRunError("gone").name).toBe("NoActiveRunError");
    expect(new TurnAttemptFailed("", new Error("boom")).name).toBe("TurnAttemptFailed");
  });

  it("reports an interrupted provider stream with its saved prefix", () => {
    expect(
      classifyTurnFailure(
        new TurnAttemptFailed("Saved prefix", new StudentHttpError(502, "response.invalid", false)),
      ),
    ).toEqual({
      detail: "",
      hasPrefix: true,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: false,
    });
  });

  it("reports an explicit failed stream chunk with the server message", () => {
    expect(classifyTurnFailure(streamFailure())).toEqual({
      code: "unavailable",
      detail: "The request exceeds the configured inference limits.",
      hasPrefix: false,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: false,
    });
  });

  it("leaves the resume hint to the presentation for a retryable stream", () => {
    expect(
      classifyTurnFailure(
        new TurnAttemptFailed("Saved prefix", streamFailure({ retryable: true })),
      ),
    ).toEqual({
      code: "unavailable",
      detail: "The request exceeds the configured inference limits.",
      hasPrefix: true,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: true,
    });
  });

  it("respects a refusing stream even with a saved prefix", () => {
    expect(classifyTurnFailure(new TurnAttemptFailed("Saved prefix", streamFailure()))).toEqual({
      code: "unavailable",
      detail: "The request exceeds the configured inference limits.",
      hasPrefix: true,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: false,
    });
  });

  it("reports a refused request without an offer to retry", () => {
    expect(classifyTurnFailure(new StudentHttpError(429, "request.invalid", false))).toEqual({
      detail: "",
      hasPrefix: false,
      kind: "request-failed",
      recoverable: true,
      retryable: false,
    });
  });

  it("offers a retry for a retryable refusal without a prefix", () => {
    expect(classifyTurnFailure(new StudentHttpError(503, "server.error", true))).toEqual({
      detail: "",
      hasPrefix: false,
      kind: "request-failed",
      recoverable: true,
      retryable: true,
    });
  });

  it("reports a missing run as fatal without an offer to retry", () => {
    for (const error of [
      new NoActiveRunError("No active student run is available."),
      new TurnAttemptFailed("", new NoActiveRunError("No active student run is available.")),
    ]) {
      expect(classifyTurnFailure(error)).toEqual({
        detail: "",
        hasPrefix: false,
        kind: "session-unavailable",
        recoverable: false,
        retryable: false,
      });
    }
  });

  it.each([
    "invalid-replay-prefix",
    "approval-not-pending",
    "approval-review-mismatch",
    "approval-message-mismatch",
  ] as const)("reports deterministic runtime refusal %s without an offer to retry", (code) => {
    expect(
      classifyTurnFailure(
        new TurnAttemptFailed(
          "Saved prefix",
          new AgentAdapterError(code, "The runtime refused the turn."),
        ),
      ),
    ).toEqual({
      detail: "",
      hasPrefix: true,
      kind: "request-failed",
      recoverable: true,
      retryable: false,
    });
  });

  it("reports an unexpected runtime failure with its diagnostic text", () => {
    expect(
      classifyTurnFailure(
        new TurnAttemptFailed("", new AgentAdapterError("upstream-contract-changed", "boom")),
      ),
    ).toEqual({
      detail: "AgentAdapterError: boom",
      hasPrefix: false,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    });
  });

  it("reports a wrapped failure without runtime diagnostics", () => {
    expect(
      classifyTurnFailure(new AgentAdapterError("upstream-execution-failed", "wrapped")),
    ).toEqual({
      detail: "NonErrorThrownValue: The upstream runtime threw a non-Error value.",
      hasPrefix: false,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    });
  });

  it("reports unknown failures with sanitized text", () => {
    expect(classifyTurnFailure(new Error("a\u001Bb"))).toEqual({
      detail: "Error: ab",
      hasPrefix: false,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    });
    expect(classifyTurnFailure("plain string")).toEqual({
      detail: "plain string",
      hasPrefix: false,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    });
    expect(classifyTurnFailure({ unexpected: true })).toEqual({
      detail: "",
      hasPrefix: false,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    });
  });

  it("follows the cause chain to the deepest recognized failure", () => {
    const inner = streamFailure({ message: "inner", retryable: true });
    const outer = new NoActiveRunError("outer wrapper");
    Object.defineProperty(outer, "cause", {
      value: new Error("middle", { cause: inner }),
    });
    expect(classifyTurnFailure(new TurnAttemptFailed("Saved prefix", outer))).toEqual({
      code: "unavailable",
      detail: "inner",
      hasPrefix: true,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: true,
    });
  });

  it("terminates on a cyclic cause chain", () => {
    const cyclic = new Error("loop");
    cyclic.cause = cyclic;
    expect(classifyTurnFailure(cyclic)).toEqual({
      detail: "Error: loop",
      hasPrefix: false,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    });
  });
});

it.each([
  ["deadline-exceeded", "deadline-exceeded"],
  ["budget-exhausted", "budget-exhausted"],
  ["concurrency-limited", "concurrency-limited"],
  ["authentication-failed", "request-failed"],
  ["usage-invalid", "request-failed"],
  ["invalid-response", "request-failed"],
])("preserves the explicit %s cause and refusal over a saved prefix", (code, kind) => {
  const failure = classifyTurnFailure(new TurnAttemptFailed("Saved", streamFailure({ code })));
  expect(failure).toEqual({
    code,
    kind,
    detail: "The request exceeds the configured inference limits.",
    hasPrefix: true,
    recoverable: true,
    retryable: false,
  });
  const persisted = new StoredTurnFailure(failure);
  expect(persisted.name).toBe("StoredTurnFailure");
  expect(persisted.message).toBe("The stored turn requires intervention.");
  expect(classifyTurnFailure(persisted)).toBe(failure);
});
