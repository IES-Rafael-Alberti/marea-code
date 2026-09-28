import {
  ModelGatewayRequestSchema,
  ModelGatewayStreamChunkSchema,
  type ModelGatewayStreamChunk,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ModelGateway } from "../model-gateway/contracts.js";
import { collectModelChunks, modelStreamResponse } from "./model-stream.js";

const request = ModelGatewayRequestSchema.parse({
  kind: "model-gateway-request",
  messages: [{ content: "Hello", role: "student" }],
  modelAlias: "marea",
  protocolVersion: "0.1",
  requestId: "request:model",
  tools: [],
});

const started = ModelGatewayStreamChunkSchema.parse({
  emittedAt: "2026-09-04T08:00:00.000Z",
  event: "started",
  modelAlias: "marea",
  protocolVersion: "0.1",
  requestId: "request:model",
  sequence: 0,
});

function pendingIteratorResult(): Promise<IteratorResult<ModelGatewayStreamChunk, void>> {
  return Promise.withResolvers<IteratorResult<ModelGatewayStreamChunk, void>>().promise;
}

describe("model stream response", () => {
  it("serializes chunks and closes at the iterator boundary", async () => {
    const gateway: ModelGateway = {
      async *stream() {
        await Promise.resolve();
        yield started;
      },
    };
    const response = modelStreamResponse(gateway, request, new AbortController().signal);

    expect(await response.text()).toBe(`${JSON.stringify(started)}\n`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.fromEntries(response.headers)).toEqual({
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
  });

  it("closes without exposing an unexpected iterator failure", async () => {
    const gateway: ModelGateway = {
      async *stream() {
        await Promise.resolve();
        yield started;
        throw new Error("private stream failure");
      },
    };

    await expect(
      modelStreamResponse(gateway, request, new AbortController().signal).text(),
    ).resolves.toBe(`${JSON.stringify(started)}\n`);
  });

  it("returns the upstream iterator when the response body is cancelled", async () => {
    const returned = vi.fn((): Promise<IteratorResult<ModelGatewayStreamChunk, void>> =>
      Promise.resolve({ done: true, value: undefined }),
    );
    const iterator: AsyncIterator<ModelGatewayStreamChunk, void> = {
      next: pendingIteratorResult,
      return: returned,
    };
    const gateway: ModelGateway = {
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return iterator;
          },
        };
      },
    };
    const response = modelStreamResponse(gateway, request, new AbortController().signal);

    await response.body?.cancel();

    expect(returned).toHaveBeenCalledOnce();
  });

  it("cancels safely when an upstream iterator has no return method", async () => {
    const gateway: ModelGateway = {
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: pendingIteratorResult,
            };
          },
        };
      },
    };
    const response = modelStreamResponse(gateway, request, new AbortController().signal);

    await expect(response.body?.cancel()).resolves.toBeUndefined();
  });

  it("collects a public model stream for deterministic acceptance checks", async () => {
    async function* stream(): AsyncIterable<ModelGatewayStreamChunk> {
      await Promise.resolve();
      yield started;
    }

    await expect(collectModelChunks(stream())).resolves.toEqual([started]);
  });
});
