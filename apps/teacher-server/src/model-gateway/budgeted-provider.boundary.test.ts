import { InferenceProviderError, type InferenceProviderEvent } from "@marea/plugin-api";
import { describe, expect, it, vi } from "vitest";
import {
  USAGE_ACCOUNT as account,
  USAGE_REQUEST as request,
} from "../../test-support/usage-fixture.js";
import { BudgetedInferenceProvider } from "./budgeted-provider.boundary.js";
import { cancellationFor } from "./inference-cancellation.js";
import {
  usage,
  completed,
  limitError,
  cancellation,
  fixture,
  collect,
  collectAttempts,
} from "./budgeted-provider.fixture.js";
describe("provider admission and durable accounting", () => {
  it("overrides caller output limits and persists settlement before announcing completion", async () => {
    const test = fixture();
    try {
      const stream = test.metered.stream({ ...request, maxOutputTokens: 999 }, cancellation());
      const iterator = stream[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ done: false, value: usage });
      expect(test.ledger.totals(account)).toEqual({
        requests: 1,
        tokens: 20,
        costUnits: 50,
        inFlight: 1,
      });
      expect(test.provider.requests).toEqual([{ ...request, maxOutputTokens: 10 }]);
      expect(await iterator.next()).toEqual({ done: false, value: completed });
      expect(test.ledger.totals(account)).toEqual({
        requests: 1,
        tokens: 11,
        costUnits: 28,
        inFlight: 0,
      });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(test.provider.closed).toBe(true);
      expect(test.provider.cancellation?.aborted).toBe(true);
    } finally {
      test.database.close();
    }
  });

  it("rejects unconfigured, miscorrelated, cancelled and incompatible-route requests without inference", async () => {
    const test = fixture();
    try {
      for (const providerInputTokenCeiling of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ])
        expect(
          () => new BudgetedInferenceProvider({ ...test.options, providerInputTokenCeiling }),
        ).toThrow();
      await expect(
        collect(test.metered.stream({ ...request, requestId: "request:other" }, cancellation())),
      ).rejects.toMatchObject(limitError);
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        collect(test.metered.stream(request, cancellationFor(aborted.signal))),
      ).rejects.toMatchObject({
        code: "aborted",
        message: "The inference request was cancelled.",
        retryable: false,
      });
      const unconfigured = new BudgetedInferenceProvider({
        ...test.options,
        account: { ...account, runId: "run:b" },
      });
      await expect(collect(unconfigured.stream(request, cancellation()))).rejects.toMatchObject(
        limitError,
      );
      expect(test.ledger.totals(account).requests).toBe(0);
      const incompatible = new BudgetedInferenceProvider({
        ...test.options,
        providerInputTokenCeiling: 11,
      });
      await expect(collect(incompatible.stream(request, cancellation()))).rejects.toMatchObject(
        limitError,
      );
      expect(test.ledger.totals(account)).toEqual({
        requests: 1,
        tokens: 0,
        costUnits: 0,
        inFlight: 0,
      });
      expect(test.provider.requests).toEqual([]);
    } finally {
      test.database.close();
    }
  });

  it("reserves each pre-stream retry and retains the uncertain charge from its failed attempt", async () => {
    const test = fixture();
    try {
      test.provider.events = [];
      test.provider.failure = new InferenceProviderError({
        code: "unavailable",
        message: "Synthetic failure",
        retryable: true,
      });
      const wait = vi.fn(() => {
        test.provider.events = [usage, completed];
        test.provider.failure = null;
        return Promise.resolve();
      });
      const output = await collectAttempts(test, wait);
      expect(output).toEqual([
        { type: "event", event: usage },
        { type: "event", event: completed },
      ]);
      expect(wait).toHaveBeenCalledOnce();
      expect(test.provider.requests).toHaveLength(2);
      expect(
        test.database.readAll("SELECT attempt, state FROM marea_usage_attempts ORDER BY attempt"),
      ).toEqual([
        { attempt: 1n, state: "unknown" },
        { attempt: 2n, state: "settled" },
      ]);
      expect(test.ledger.totals(account)).toEqual({
        requests: 2,
        tokens: 31,
        costUnits: 78,
        inFlight: 0,
      });
    } finally {
      test.database.close();
    }
  });

  it("never retries partial output and charges cancellation or early consumer return conservatively", async () => {
    const test = fixture();
    try {
      const text: InferenceProviderEvent = { type: "text-delta", text: "Partial" };
      test.provider.events = [text];
      test.provider.failure = new InferenceProviderError({
        code: "unavailable",
        message: "Synthetic failure",
        retryable: true,
      });
      const wait = vi.fn(() => Promise.resolve());
      const output = await collectAttempts(test, wait);
      expect(output).toEqual([
        { type: "event", event: text },
        {
          type: "failure",
          failure: { code: "unavailable", message: "Synthetic failure", retryable: true },
        },
      ]);
      expect(wait).not.toHaveBeenCalled();
      test.provider.failure = null;
      const iterator = test.metered.stream(request, cancellation())[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ done: false, value: text });
      await iterator.return?.();
      expect(test.ledger.totals(account)).toEqual({
        requests: 2,
        tokens: 40,
        costUnits: 100,
        inFlight: 0,
      });
      expect(test.provider.cancellation?.aborted).toBe(true);
    } finally {
      test.database.close();
    }
  });

  it("rejects absent, malformed and decreasing usage without refunding uncertain reservations", async () => {
    for (const events of [
      [],
      [completed],
      [usage],
      [{ ...usage, inputTokens: -1 }, completed],
      [{ ...usage, outputTokens: 0.5 }, completed],
      [usage, { ...usage, inputTokens: 4 }, completed],
      [usage, { ...usage, outputTokens: 5 }, completed],
    ]) {
      const test = fixture();
      try {
        test.provider.events = events;
        await expect(collect(test.metered.stream(request, cancellation()))).rejects.toMatchObject({
          code: "usage-invalid",
          message: "The provider did not report valid final usage.",
          retryable: false,
        });
        expect(test.ledger.totals(account)).toEqual({
          requests: 1,
          tokens: 20,
          costUnits: 50,
          inFlight: 0,
        });
      } finally {
        test.database.close();
      }
    }
  });

  it("accepts equal or increasing cumulative usage but quarantines a reported token overage", async () => {
    for (const exceeded of [null, "input", "output"] as const) {
      const test = fixture();
      try {
        test.provider.events = [
          usage,
          usage,
          {
            type: "usage",
            inputTokens: exceeded === "input" ? 11 : 10,
            outputTokens: exceeded === "output" ? 11 : 10,
          },
          completed,
        ];
        const output = collect(test.metered.stream(request, cancellation()));
        if (exceeded === null) {
          await expect(output).resolves.toEqual(test.provider.events);
          expect(test.ledger.totals(account).costUnits).toBe(50);
        } else {
          await expect(output).rejects.toMatchObject(limitError);
          expect(test.database.readOne("SELECT state FROM marea_usage_attempts")?.state).toBe(
            "breached",
          );
          await expect(collect(test.metered.stream(request, cancellation()))).rejects.toMatchObject(
            limitError,
          );
          expect(test.provider.requests).toHaveLength(1);
        }
      } finally {
        test.database.close();
      }
    }
  });

  it("checks the shared tool allowance before exposing each tool call", async () => {
    const test = fixture();
    try {
      const first: InferenceProviderEvent = {
        type: "tool-call",
        callId: "call:one",
        name: "write_file",
        arguments: { path: "file" },
      };
      test.provider.events = [first, { ...first, callId: "call:two" }, usage, completed];
      const iterator = test.metered.stream(request, cancellation())[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ done: false, value: first });
      await expect(iterator.next()).rejects.toMatchObject(limitError);
      expect(test.database.readAll("SELECT call_id FROM marea_usage_tool_calls")).toEqual([
        { call_id: "call:one" },
      ]);
      expect(test.ledger.totals(account).costUnits).toBe(50);
    } finally {
      test.database.close();
    }
  });

  it("does not announce completion if durable settlement fails", async () => {
    const test = fixture();
    try {
      vi.spyOn(test.ledger, "settle").mockImplementationOnce(() => {
        throw new Error("Synthetic storage failure");
      });
      const iterator = test.metered.stream(request, cancellation())[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ done: false, value: usage });
      await expect(iterator.next()).rejects.toThrow("Synthetic storage failure");
      expect(test.database.readOne("SELECT state FROM marea_usage_attempts")?.state).toBe(
        "unknown",
      );
      expect(test.ledger.totals(account).inFlight).toBe(0);
    } finally {
      test.database.close();
    }
  });
});
