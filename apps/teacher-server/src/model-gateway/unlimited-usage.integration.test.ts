import { afterEach, expect, it, vi } from "vitest";
import type { InferenceProviderEvent } from "@marea/plugin-api";
import { USAGE_POLICY, USAGE_REQUEST, USAGE_ACCOUNT } from "../../test-support/usage-fixture.js";
import { NOW } from "../../test-support/history-fixture.js";
import { fixture, collect, cancellation, completed } from "./budgeted-provider.fixture.js";
import { streamWithinDeadline } from "./inference-deadline.boundary.js";
import { cancellationFor } from "./inference-cancellation.js";
import { BudgetedInferenceProvider } from "./budgeted-provider.boundary.js";
const unlimited = {
  ...USAGE_POLICY,
  unlimited: true,
  maxInputTokens: 1,
  maxOutputTokens: 1,
  maxRequests: 0,
  maxTokens: 0,
  maxCostUnits: 0,
  maxToolCalls: 0,
};
afterEach(() => {
  vi.useRealTimers();
});
it("admits requests and tools beyond every ceiling while recording actual usage and cost", async () => {
  const f = fixture(unlimited);
  const diagnostic = vi.fn();
  const provider = new BudgetedInferenceProvider({ ...f.options, diagnostic });
  try {
    f.provider.events = [
      { type: "tool-call", name: "read_file", arguments: {}, callId: "call:one" },
      { type: "tool-call", name: "read_file", arguments: {}, callId: "call:two" },
      { type: "usage", inputTokens: 50, outputTokens: 60 },
      completed,
    ];
    for (let i = 0; i < 2; i++)
      await expect(collect(provider.stream(USAGE_REQUEST, cancellation()))).resolves.toEqual(
        f.provider.events,
      );
    expect(f.provider.requests).toEqual([USAGE_REQUEST, USAGE_REQUEST]);
    expect(f.ledger.totals(USAGE_ACCOUNT)).toEqual({
      requests: 2,
      tokens: 220,
      costUnits: 560,
      inFlight: 0,
    });
    expect(diagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({ limitMs: null, code: "completed", settlement: "settled" }),
    );
    for (const id of ["parallel:one", "parallel:two"])
      expect(
        f.ledger.reserve({
          ...USAGE_ACCOUNT,
          reservationId: id,
          requestId: id,
          attempt: 1,
          now: NOW,
        }).admitted,
      ).toBe(true);
    expect(f.ledger.totals(USAGE_ACCOUNT)).toEqual({
      requests: 4,
      tokens: 220,
      costUnits: 560,
      inFlight: 2,
    });
  } finally {
    f.database.close();
  }
});
it("still requires valid final usage when limits are disabled", async () => {
  const f = fixture(unlimited);
  try {
    f.provider.events = [completed];
    await expect(collect(f.metered.stream(USAGE_REQUEST, cancellation()))).rejects.toMatchObject({
      code: "usage-invalid",
    });
    expect(f.ledger.totals(USAGE_ACCOUNT)).toEqual({
      requests: 1,
      tokens: 0,
      costUnits: 0,
      inFlight: 0,
    });
  } finally {
    f.database.close();
  }
});
it("does not impose a deadline but still cancels an uncooperative provider promptly", async () => {
  vi.useFakeTimers();
  const deferred = Promise.withResolvers<IteratorResult<InferenceProviderEvent>>();
  const controller = new AbortController();
  const cleanup = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
  const stream = vi.fn(() => ({
    [Symbol.asyncIterator]: () => ({ next: () => deferred.promise, return: cleanup }),
  }));
  const iterator = streamWithinDeadline(
    { stream },
    USAGE_REQUEST,
    cancellationFor(controller.signal),
    null,
  );
  const pending = iterator.next();
  const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2147483647);
  expect(cleanup).not.toHaveBeenCalled();
  controller.abort();
  await rejected;
  expect(cleanup).toHaveBeenCalledOnce();
  deferred.resolve({ done: true, value: undefined });
});
