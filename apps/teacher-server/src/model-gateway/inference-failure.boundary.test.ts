import { InferenceProviderError } from "@marea/plugin-api";
import { expect, it, vi } from "vitest";

import {
  InferenceFailure,
  inferenceFailure,
  reportInference,
} from "./inference-failure.boundary.js";

it("preserves local failures, translates provider failures and hides unknown diagnostics", () => {
  const local = new InferenceFailure("deadline-exceeded", "Limit reached");
  expect(local.name).toBe("InferenceFailure");
  expect(local.message).toBe("Limit reached");
  expect(local.retryable).toBe(false);
  expect(inferenceFailure(local)).toBe(local);
  const provider = inferenceFailure(
    new InferenceProviderError({ code: "rate-limited", message: "Wait", retryable: true }),
  );
  expect(provider).toMatchObject({ code: "rate-limited", message: "Wait", retryable: true });
  expect(inferenceFailure(new Error("Private socket password"))).toMatchObject({
    code: "inference-failed",
    message: "The inference request failed.",
    retryable: false,
  });
});

it("makes diagnostics immutable and isolates sink errors", () => {
  const event = {
    runId: "run:test",
    requestId: "request:test",
    attempt: 1,
    startedAt: "start",
    endedAt: "end",
    durationMs: 1,
    limitMs: null,
    code: "completed",
    emitted: false,
    settlement: "settled" as const,
    retryable: false,
    retryBlockedBy: null,
  };
  const sink = vi.fn((received: object) => {
    expect(Object.isFrozen(received)).toBe(true);
    throw new Error("sink");
  });
  expect(() => {
    reportInference(sink, event);
  }).not.toThrow();
  expect(sink).toHaveBeenCalledExactlyOnceWith(event);
  const unused = { ...event };
  expect(() => {
    reportInference(undefined, unused);
  }).not.toThrow();
  expect(Object.isFrozen(unused)).toBe(false);
});
