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
