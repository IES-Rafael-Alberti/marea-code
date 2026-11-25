import {
  InferenceProviderError,
  type InferenceProvider,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "@marea/plugin-api";
import { describe, expect, it } from "vitest";

import { providerStream, type ProviderStreamResult } from "./provider-stream.boundary.js";

const request: InferenceProviderRequest = {
  messages: [],
  requestId: "request:boundary",
  tools: [],
  upstreamModel: "private-model",
};

function failingProvider(error: Error): InferenceProvider {
  return {
    async *stream(): AsyncIterable<InferenceProviderEvent> {
      await Promise.resolve();
      yield* [];
      throw error;
    },
  };
}

async function collect(stream: AsyncIterable<ProviderStreamResult>) {
  const results: ProviderStreamResult[] = [];
  for await (const result of stream) results.push(result);
  return results;
}

describe("provider stream boundary", () => {
  it("wraps a successful provider event in the canonical boundary result", async () => {
    const provider: InferenceProvider = {
      async *stream(): AsyncIterable<InferenceProviderEvent> {
        await Promise.resolve();
        yield { text: "Hello", type: "text-delta" };
      },
    };

    await expect(
      collect(
        providerStream(
          request,
          { provider, upstreamModel: "private-model" },
          { wait: () => Promise.resolve() },
          new AbortController().signal,
        ),
      ),
    ).resolves.toEqual([{ event: { text: "Hello", type: "text-delta" }, type: "event" }]);
  });

  it("finishes after a non-retryable provider failure", async () => {
    const results = await collect(
      providerStream(
        request,
        {
          provider: failingProvider(
            new InferenceProviderError({
              code: "authentication-failed",
              message: "Safe failure.",
              retryable: false,
            }),
          ),
          upstreamModel: "private-model",
        },
        { wait: () => Promise.resolve() },
        new AbortController().signal,
      ),
    );

    expect(results).toEqual([
      {
        failure: {
          code: "authentication-failed",
          message: "Safe failure.",
          retryable: false,
        },
        type: "failure",
      },
    ]);
  });

  it("finishes safely when the retry scheduler fails", async () => {
    const results = await collect(
      providerStream(
        request,
        {
          provider: failingProvider(
            new InferenceProviderError({
              code: "unavailable",
              message: "Unavailable.",
              retryable: true,
            }),
          ),
          upstreamModel: "private-model",
        },
        {
          wait: () =>
            Promise.reject(
              new InferenceProviderError({
                code: "unavailable",
                message: "Retry stopped.",
                retryable: true,
              }),
            ),
        },
        new AbortController().signal,
      ),
    );

    expect(results).toEqual([
      {
        failure: {
          code: "unavailable",
          message: "Retry stopped.",
          retryable: false,
        },
        type: "failure",
      },
    ]);
  });
});

describe("automatic provider retries", () => {
  function scripted(...attempts: readonly (readonly InferenceProviderEvent[] | Error)[]) {
    let calls = 0;
    const provider: InferenceProvider = {
      async *stream(): AsyncIterable<InferenceProviderEvent> {
        await Promise.resolve();
        const attempt = attempts[calls++] ?? [];
        if (attempt instanceof Error) {
          yield* [];
          throw attempt;
        }
        yield* attempt;
      },
    };
    return { provider, calls: () => calls };
  }
  const invalid = () =>
    new InferenceProviderError({
      code: "invalid-response",
      message: "The inference provider returned an invalid tool call.",
      retryable: false,
    });
  const run = (provider: InferenceProvider, waits: string[] = []) =>
    collect(
      providerStream(
        request,
        { provider, upstreamModel: "private-model" },
        {
          wait: (error) => {
            waits.push(error.code);
            return Promise.resolve();
          },
        },
        new AbortController().signal,
      ),
    );

  it("retries an unreadable response, even after usage, and returns the next valid one", async () => {
    const usage: InferenceProviderEvent = { type: "usage", inputTokens: 3, outputTokens: 1 };
    const failingAfterUsage: InferenceProvider = {
      async *stream(): AsyncIterable<InferenceProviderEvent> {
        await Promise.resolve();
        yield usage;
        throw invalid();
      },
    };
    let calls = 0;
    const provider: InferenceProvider = {
      stream: (input, cancellation) => {
        calls += 1;
        return calls === 1
          ? failingAfterUsage.stream(input, cancellation)
          : scripted([{ text: "ok", type: "text-delta" }]).provider.stream(input, cancellation);
      },
    };
    const waits: string[] = [];
    const results = await run(provider, waits);
    expect(waits).toEqual(["invalid-response"]);
    expect(results).toEqual([
      { event: usage, type: "event" },
      { event: { text: "ok", type: "text-delta" }, type: "event" },
    ]);
  });

  it("gives up after the first attempt and two retries", async () => {
    const subject = scripted(invalid(), invalid(), invalid(), [
      { text: "late", type: "text-delta" },
    ]);
    const waits: string[] = [];
    const results = await run(subject.provider, waits);
    expect(subject.calls()).toBe(3);
    expect(waits).toHaveLength(2);
    expect(results).toEqual([
      {
        failure: {
          code: "invalid-response",
          message: "The inference provider returned an invalid tool call.",
          retryable: false,
        },
        type: "failure",
      },
    ]);
  });

  it("never retries once text has reached the client", async () => {
    const partial: InferenceProvider = {
      async *stream(): AsyncIterable<InferenceProviderEvent> {
        await Promise.resolve();
        yield { text: "partial", type: "text-delta" };
        throw invalid();
      },
    };
    const waits: string[] = [];
    const results = await run(partial, waits);
    expect(waits).toEqual([]);
    expect(results.at(-1)).toMatchObject({ type: "failure" });
  });
});
