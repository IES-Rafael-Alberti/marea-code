import { describe, expect, it } from "vitest";

import { InferenceProviderError } from "@marea/plugin-api";

import type { OpenRouterHttpPort } from "./contracts.js";
import {
  collect,
  httpResponse,
  REQUEST,
  sse,
  TestCancellation,
  TestHttp,
  toolCallChunk,
} from "./openrouter.fixture.js";
import { createOpenRouterProviderWith } from "./provider.js";

const CONFIGURATION = Object.freeze({
  apiKey: "server-secret",
  endpoint: "https://openrouter.example/api",
});

function provider(http: OpenRouterHttpPort) {
  return createOpenRouterProviderWith(CONFIGURATION, http);
}

function expectProviderError(
  promise: Promise<readonly object[]>,
  expected: Partial<InferenceProviderError>,
): Promise<void> {
  return expect(promise).rejects.toMatchObject(expected);
}

describe("OpenRouter inference provider", () => {
  it("streams text, usage, and completion in normalized order", async () => {
    const http = new TestHttp(
      httpResponse(
        sse(
          JSON.stringify({
            choices: [{ index: 0, delta: { content: "Hola" }, finish_reason: null }],
          }),
          JSON.stringify({
            choices: [{ index: 0, delta: { content: " mundo" }, finish_reason: "stop" }],
          }),
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          }),
        ),
      ),
    );
    const cancellation = new TestCancellation();

    await expect(
      collect(
        createOpenRouterProviderWith(CONFIGURATION, http, (request) =>
          Promise.resolve({ ...request, maxOutputTokens: 256, contextWindowTokens: 262_144 }),
        ).stream(REQUEST, cancellation),
      ),
    ).resolves.toEqual([
      { text: "Hola", type: "text-delta" },
      { text: " mundo", type: "text-delta" },
      { inputTokens: 4, outputTokens: 2, contextWindowTokens: 262_144, type: "usage" },
      { finishReason: "stop", type: "completed" },
    ]);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.body.maxOutputTokens).toBe(256);
    expect(http.requests[0]).toMatchObject({
      apiKey: "server-secret",
      body: REQUEST,
      endpoint: "https://openrouter.example/api",
    });
    expect(cancellation.unsubscribed).toBe(true);
  });

  it("assembles indexed tool-call fragments and maps their finish reason", async () => {
    const http = new TestHttp(
      httpResponse(
        sse(
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  content: null,
                  tool_calls: [
                    {
                      index: 1,
                      id: "call-b",
                      function: { name: "write_file", arguments: '{"pa' },
                    },
                    {
                      index: 0,
                      id: "call-a",
                      function: { name: "write_file", arguments: '{"path":"a.txt"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 1, function: { arguments: 'th":"b.txt","content":"B"}' } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        ),
      ),
    );

    await expect(collect(provider(http).stream(REQUEST, new TestCancellation()))).resolves.toEqual([
      { arguments: { path: "a.txt" }, callId: "call-a", name: "write_file", type: "tool-call" },
      {
        arguments: { path: "b.txt", content: "B" },
        callId: "call-b",
        name: "write_file",
        type: "tool-call",
      },
      { finishReason: "tool-call", type: "completed" },
    ]);
  });

  it.each([
    [
      401,
      {},
      "authentication-failed",
      "The inference provider rejected its server credential.",
      false,
      undefined,
    ],
    [
      403,
      {},
      "authentication-failed",
      "The inference provider rejected its server credential.",
      false,
      undefined,
    ],
    [
      429,
      { "retry-after": "3" },
      "rate-limited",
      "The inference provider rate limit was reached.",
      true,
      3_000,
    ],
    [429, {}, "rate-limited", "The inference provider rate limit was reached.", true, undefined],
    [
      429,
      { "retry-after": "+3" },
      "rate-limited",
      "The inference provider rate limit was reached.",
      true,
      undefined,
    ],
    [
      429,
      { "retry-after": "3e0" },
      "rate-limited",
      "The inference provider rate limit was reached.",
      true,
      undefined,
    ],
    [
      429,
      { "retry-after": "12" },
      "rate-limited",
      "The inference provider rate limit was reached.",
      true,
      12_000,
    ],
    [
      429,
      { "retry-after": "86400" },
      "rate-limited",
      "The inference provider rate limit was reached.",
      true,
      86_400_000,
    ],
    [
      429,
      { "retry-after": "86401" },
      "rate-limited",
      "The inference provider rate limit was reached.",
      true,
      undefined,
    ],
    [500, {}, "unavailable", "The inference provider is unavailable.", true, undefined],
    [400, {}, "invalid-response", "The inference provider rejected the request.", false, undefined],
  ] as const)(
    "maps HTTP %i to a safe classified error",
    async (status, headers, code, message, retryable, retryAfterMs) => {
      const response = httpResponse("private body", { headers, status });

      await expectProviderError(
        collect(provider(new TestHttp(response)).stream(REQUEST, new TestCancellation())),
        { code, message, retryable, retryAfterMs },
      );
    },
  );

  it("classifies request failure and pre-request cancellation", async () => {
    const unavailable: OpenRouterHttpPort = {
      send() {
        return Promise.reject(new Error("private network detail"));
      },
    };
    const cancelled = new TestCancellation();
    cancelled.abort();

    await expectProviderError(
      collect(provider(unavailable).stream(REQUEST, new TestCancellation())),
      {
        code: "unavailable",
        message: "The inference provider is unavailable.",
        retryable: true,
      },
    );
    await expectProviderError(collect(provider(unavailable).stream(REQUEST, cancelled)), {
      code: "aborted",
      message: "The inference request was cancelled.",
      retryable: false,
    });
    expect(cancelled.unsubscribed).toBe(false);
  });

  it("aborts an in-flight HTTP operation and releases its subscription", async () => {
    const cancellation = new TestCancellation();
    const waiting: OpenRouterHttpPort = {
      send(request) {
        cancellation.abort();
        return Promise.reject(new Error(String(request.signal.aborted)));
      },
    };

    await expectProviderError(collect(provider(waiting).stream(REQUEST, cancellation)), {
      code: "aborted",
      message: "The inference request was cancelled.",
    });
    expect(cancellation.unsubscribed).toBe(true);
  });

  it.each([
    ["missing body", { body: null, headers: new Headers(), ok: true, status: 200 }],
    ["invalid JSON", httpResponse(sse("not-json"))],
    ["invalid schema", httpResponse(sse('{"choices":"private"}'))],
    [
      "missing completion",
      httpResponse('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'),
    ],
  ] as const)("rejects %s as an invalid response", async (label, response) => {
    await expectProviderError(
      collect(provider(new TestHttp(response)).stream(REQUEST, new TestCancellation())),
      {
        code: label === "missing completion" ? "unavailable" : "invalid-response",
        retryable: label === "missing completion",
      },
    );
  });

  it.each([
    [toolCallChunk({ arguments: "{}" }), ["missing-name", "missing-id"]],
    [toolCallChunk({ arguments: "{", id: "call", name: "write_file" }), ["malformed-arguments"]],
    [
      toolCallChunk({ arguments: '{"path":3}', id: "call", name: "write_file" }),
      ["non-string-argument"],
    ],
  ] as const)(
    "repairs a malformed tool call instead of failing the response",
    async (chunk, causes) => {
      const events = await collect(
        provider(new TestHttp(httpResponse(sse(chunk)))).stream(REQUEST, new TestCancellation()),
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "tool-call", repair: { causes } });
      expect(events[1]).toEqual({ finishReason: "tool-call", type: "completed" });
    },
  );

  it("emits charged usage before the tool calls of the same response", async () => {
    const response = httpResponse(
      sse(
        toolCallChunk({ arguments: '{"pattern":"x"}', id: "call-1", name: "grep" }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 20_681, completion_tokens: 296 } }),
      ),
    );
    await expect(
      collect(provider(new TestHttp(response)).stream(REQUEST, new TestCancellation())),
    ).resolves.toStrictEqual([
      { inputTokens: 20_681, outputTokens: 296, type: "usage" },
      { arguments: { pattern: "x" }, callId: "call-1", name: "grep", type: "tool-call" },
      { finishReason: "tool-call", type: "completed" },
    ]);
  });

  it("reports usage even when the response then fails without a finish reason", async () => {
    const response = httpResponse(
      sse(JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } })),
    );
    const seen: object[] = [];
    await expectProviderError(
      (async () => {
        for await (const event of provider(new TestHttp(response)).stream(
          REQUEST,
          new TestCancellation(),
        ))
          seen.push(event);
        return seen;
      })(),
      { code: "unavailable", retryable: true },
    );
    expect(seen).toEqual([{ inputTokens: 5, outputTokens: 1, type: "usage" }]);
  });

  it("preserves length as a normalized finish reason", async () => {
    const response = httpResponse(
      sse(
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }],
        }),
      ),
    );
    await expect(
      collect(provider(new TestHttp(response)).stream(REQUEST, new TestCancellation())),
    ).resolves.toEqual([
      { text: "partial", type: "text-delta" },
      { finishReason: "length", type: "completed" },
    ]);
  });

  it("ignores empty content and requires the completion sentinel", async () => {
    const response = httpResponse(
      'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}\n\n',
    );

    await expectProviderError(
      collect(provider(new TestHttp(response)).stream(REQUEST, new TestCancellation())),
      {
        code: "unavailable",
        message: "The inference provider stream was interrupted.",
        retryable: true,
      },
    );
  });

  it("does not emit an empty text delta from a completed stream", async () => {
    const response = httpResponse(
      sse(
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
        }),
      ),
    );

    await expect(
      collect(provider(new TestHttp(response)).stream(REQUEST, new TestCancellation())),
    ).resolves.toEqual([{ finishReason: "stop", type: "completed" }]);
  });

  it("reports a stable message for a missing body", async () => {
    await expectProviderError(
      collect(
        provider(
          new TestHttp({ body: null, headers: new Headers(), ok: true, status: 200 }),
        ).stream(REQUEST, new TestCancellation()),
      ),
      {
        code: "invalid-response",
        message: "The inference provider returned no stream body.",
        retryable: false,
      },
    );
  });
});

it.each([false, true])(
  "classifies a broken response body separately from cancellation (%s)",
  async (cancelled) => {
    const cancellation = new TestCancellation();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled) cancellation.abort();
        controller.error(new Error("Private socket diagnostic"));
      },
    });
    const http = new TestHttp({ body, headers: new Headers(), status: 200, ok: true });
    await expectProviderError(collect(provider(http).stream(REQUEST, cancellation)), {
      code: cancelled ? "aborted" : "unavailable",
      message: cancelled
        ? "The inference request was cancelled."
        : "The inference provider stream was interrupted.",
      retryable: !cancelled,
    });
    expect(cancellation.unsubscribed).toBe(true);
  },
);

it("rejects a failed context admission before sending inference and releases cancellation", async () => {
  const http = new TestHttp(httpResponse(sse()));
  const cancellation = new TestCancellation();
  const guarded = createOpenRouterProviderWith(CONFIGURATION, http, () =>
    Promise.reject(
      new InferenceProviderError({
        code: "context-exceeded",
        message: "Reduce materials",
        retryable: false,
      }),
    ),
  );
  await expect(collect(guarded.stream(REQUEST, cancellation))).rejects.toMatchObject({
    code: "context-exceeded",
  });
  expect(http.requests).toHaveLength(0);
  expect(cancellation.unsubscribed).toBe(true);
});
