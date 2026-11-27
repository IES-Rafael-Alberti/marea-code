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
} from "./openrouter.fixture.js";
import { createOpenRouterProviderWith } from "./provider.js";

function provider(http: OpenRouterHttpPort) {
  return createOpenRouterProviderWith(
    { apiKey: "server-secret", endpoint: "https://openrouter.example/api" },
    http,
  );
}

function expectProviderError(
  promise: Promise<readonly object[]>,
  expected: Partial<InferenceProviderError>,
): Promise<void> {
  return expect(promise).rejects.toMatchObject(expected);
}

/**
 * Failures after the answer began streaming. Each one that is safe to retry is reported as an
 * interrupted answer (`unavailable`, retryable), so Marea regenerates it; each names its spot.
 */
describe("OpenRouter mid-stream failures", () => {
  // Each case names the spot that ended the answer, so a turn diagnostic tells them apart.
  it.each([
    [
      "a stream closed without a finish reason",
      "data: [DONE]\n\n",
      "The inference provider stream ended before completion.",
    ],
    [
      "an unsupported finish reason",
      sse(
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "insufficient_system_resource",
            },
          ],
        }),
      ),
      "The inference provider ended the answer with an unsupported finish reason (insufficient_system_resource).",
    ],
    [
      "a mid-stream error chunk without choices",
      sse(JSON.stringify({ error: { code: 502, message: "Provider disconnected: private" } })),
      "The inference provider reported an error while streaming (502).",
    ],
    [
      "a mid-stream error chunk with choices",
      sse(
        JSON.stringify({
          error: { code: "server_error", message: "private" },
          choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
        }),
      ),
      "The inference provider reported an error while streaming (server_error).",
    ],
    [
      "a mid-stream error chunk without a code",
      sse(JSON.stringify({ error: { message: "private" } })),
      "The inference provider reported an error while streaming (unknown).",
    ],
  ] as const)("retries %s as an interrupted answer", async (_label, body, message) => {
    const seen: object[] = [];
    await expectProviderError(
      (async () => {
        for await (const event of provider(
          new TestHttp(
            httpResponse(`data: {"choices":[{"index":0,"delta":{"content":"Hola"}}]}\n\n${body}`),
          ),
        ).stream(REQUEST, new TestCancellation()))
          seen.push(event);
        return seen;
      })(),
      { code: "unavailable", message, retryable: true },
    );
    expect(seen).toEqual([{ text: "Hola", type: "text-delta" }]);
  });

  it("ignores a chunk without choices that reports nothing", async () => {
    await expect(
      collect(
        provider(
          new TestHttp(
            httpResponse(
              `data: {"id":"gen-1","provider":"DeepSeek"}\n\n${sse(
                JSON.stringify({
                  choices: [{ index: 0, delta: { content: "Hola" }, finish_reason: "stop" }],
                }),
              )}`,
            ),
          ),
        ).stream(REQUEST, new TestCancellation()),
      ),
    ).resolves.toEqual([
      { text: "Hola", type: "text-delta" },
      { finishReason: "stop", type: "completed" },
    ]);
  });
});
