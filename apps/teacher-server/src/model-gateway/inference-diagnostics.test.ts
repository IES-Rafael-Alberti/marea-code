import { InferenceProviderError, type InferenceProviderEvent } from "@marea/plugin-api";
import { expect, it, vi } from "vitest";
import { NOW } from "../../test-support/history-fixture.js";
import {
  USAGE_ACCOUNT as account,
  USAGE_POLICY as policy,
  USAGE_REQUEST as request,
} from "../../test-support/usage-fixture.js";
import { BudgetedInferenceProvider } from "./budgeted-provider.boundary.js";
import { providerStream } from "./provider-stream.boundary.js";
import {
  usage,
  completed,
  limitError,
  signal,
  cancellation,
  fixture,
  collect,
} from "./budgeted-provider.fixture.js";

it.each([
  ["tokens", { maxTokens: 20 }],
  ["cost", { maxCostUnits: 50 }],
  ["requests", { maxRequests: 1 }],
])("settles unknown usage before denying a retry exhausted by %s", async (reason, limits) => {
  const test = fixture({ ...policy, ...limits });
  const diagnostic = vi.fn();
  const metered = new BudgetedInferenceProvider({ ...test.options, diagnostic });
  try {
    test.provider.events = [];
    test.provider.failure = new InferenceProviderError({
      code: "unavailable",
      message: "Interrupted",
      retryable: true,
    });
    const wait = vi.fn();
    const events = await collect(
      providerStream(
        request,
        { provider: metered, upstreamModel: request.upstreamModel },
        { wait },
        signal(),
      ),
    );
    expect(events).toEqual([
      {
        type: "failure",
        failure: { code: "unavailable", message: "Interrupted", retryable: false },
      },
    ]);
    expect(wait).not.toHaveBeenCalled();
    expect(test.ledger.totals(account)).toEqual({
      requests: 1,
      tokens: 20,
      costUnits: 50,
      inFlight: 0,
    });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      runId: account.runId,
      requestId: request.requestId,
      attempt: 1,
      startedAt: NOW,
      endedAt: NOW,
      durationMs: 0,
      limitMs: 1000,
      code: "unavailable",
      emitted: false,
      settlement: "unknown",
      retryable: false,
      retryBlockedBy: reason,
    });
    await expect(collect(metered.stream(request, cancellation()))).rejects.toMatchObject(
      limitError,
    );
    expect(test.provider.requests).toHaveLength(1);
    expect(diagnostic.mock.calls[1]?.[0]).toMatchObject({
      attempt: 2,
      code: "budget-exhausted",
      settlement: "not-admitted",
      limitMs: null,
      retryBlockedBy: reason,
    });
  } finally {
    test.database.close();
  }
});

it("distinguishes concurrent work without consuming another reservation", async () => {
  const test = fixture();
  const diagnostic = vi.fn();
  const metered = new BudgetedInferenceProvider({ ...test.options, diagnostic });
  try {
    test.ledger.reserve({
      ...account,
      reservationId: "held",
      requestId: "request:held",
      attempt: 1,
      now: NOW,
    });
    await expect(collect(metered.stream(request, cancellation()))).rejects.toMatchObject({
      code: "concurrency-limited",
      message: "Another inference request is in progress.",
      retryable: true,
    });
    expect(test.provider.requests).toEqual([]);
    expect(test.ledger.totals(account).requests).toBe(1);
    expect(diagnostic.mock.calls[0]?.[0]).toMatchObject({
      code: "concurrency-limited",
      emitted: false,
      retryable: true,
      retryBlockedBy: "concurrency",
      settlement: "not-admitted",
    });
    test.ledger.settle("held", { inputTokens: 0, outputTokens: 0 }, NOW);
    expect(await collect(metered.stream(request, cancellation()))).toEqual([usage, completed]);
  } finally {
    test.database.close();
  }
});

it("reports only bounded metadata and tolerates a broken diagnostic sink", async () => {
  const test = fixture();
  const diagnostic = vi.fn((event: object) => {
    expect(Object.isFrozen(event)).toBe(true);
    throw new Error("Private diagnostic failure");
  });
  const endedAt = "2026-01-01T00:01:12.000Z";
  const clock = {
    now: vi.fn().mockReturnValueOnce("2026-01-01T00:00:00.000Z").mockReturnValue(endedAt),
  };
  const metered = new BudgetedInferenceProvider({ ...test.options, clock, diagnostic });
  try {
    test.provider.events = [{ type: "text-delta", text: "Private answer" }, usage, completed];
    expect(await collect(metered.stream(request, cancellation()))).toEqual(test.provider.events);
    expect(test.ledger.totals(account)).toEqual({
      requests: 1,
      tokens: 11,
      costUnits: 28,
      inFlight: 0,
    });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      runId: account.runId,
      requestId: request.requestId,
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt,
      durationMs: 72000,
      limitMs: 1000,
      code: "completed",
      emitted: true,
      settlement: "settled",
      retryable: false,
      retryBlockedBy: null,
    });
  } finally {
    test.database.close();
  }
});

it("records deadline expiry after output and conservatively settles before reporting", async () => {
  vi.useFakeTimers();
  const test = fixture();
  const diagnostic = vi.fn();
  const clock = { now: () => new Date().toISOString() };
  const provider = {
    async *stream(): AsyncIterable<InferenceProviderEvent> {
      yield { type: "text-delta", text: "Saved prefix" };
      await new Promise(() => undefined);
    },
  };
  const metered = new BudgetedInferenceProvider({ ...test.options, provider, clock, diagnostic });
  try {
    const iterator = metered.stream(request, cancellation())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text-delta", text: "Saved prefix" });
    const failed = expect(iterator.next()).rejects.toMatchObject({
      code: "deadline-exceeded",
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(test.ledger.totals(account)).toEqual({
      requests: 1,
      tokens: 20,
      costUnits: 50,
      inFlight: 0,
    });
    expect(diagnostic.mock.calls[0]?.[0]).toMatchObject({
      code: "deadline-exceeded",
      emitted: true,
      settlement: "unknown",
      retryable: false,
      retryBlockedBy: null,
      durationMs: 1000,
    });
  } finally {
    test.database.close();
    vi.useRealTimers();
  }
});

it("records early consumer return and allows manual recovery of a charged partial stream", async () => {
  const test = fixture();
  const diagnostic = vi.fn();
  const metered = new BudgetedInferenceProvider({ ...test.options, diagnostic });
  try {
    test.provider.events = [{ type: "text-delta", text: "Partial" }];
    const iterator = metered.stream(request, cancellation())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(diagnostic.mock.calls[0]?.[0]).toMatchObject({
      code: "aborted",
      emitted: true,
      settlement: "unknown",
      retryable: false,
    });
    test.provider.failure = new InferenceProviderError({
      code: "unavailable",
      message: "Interrupted",
      retryable: true,
    });
    await expect(collect(metered.stream(request, cancellation()))).rejects.toBe(
      test.provider.failure,
    );
    expect(diagnostic.mock.calls[1]?.[0]).toMatchObject({
      code: "unavailable",
      emitted: true,
      settlement: "unknown",
      retryable: true,
      retryBlockedBy: null,
    });
    expect(test.ledger.totals(account)).toEqual({
      requests: 2,
      tokens: 40,
      costUnits: 100,
      inFlight: 0,
    });
  } finally {
    test.database.close();
  }
});

it("does not report internal usage events as emitted output", async () => {
  const test = fixture();
  const diagnostic = vi.fn();
  const metered = new BudgetedInferenceProvider({ ...test.options, diagnostic });
  try {
    expect(await collect(metered.stream(request, cancellation()))).toEqual([usage, completed]);
    expect(diagnostic.mock.calls[0]?.[0]).toMatchObject({
      code: "completed",
      emitted: false,
      settlement: "settled",
    });
  } finally {
    test.database.close();
  }
});
