/* eslint-disable @typescript-eslint/require-await */
import {
  ModelGatewayRequestSchema,
  RunTokenSchema,
  type ModelGatewayStreamChunk,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { StudentHttpError, createHttpModelGateway } from "./http-client.boundary.js";
import { invalidUtf8Response } from "./http-test.fixture.js";

const runToken = RunTokenSchema.parse("r".repeat(32));
const timestamp = "2026-09-04T10:00:00.000Z";
const modelRequest = ModelGatewayRequestSchema.parse({
  kind: "model-gateway-request",
  protocolVersion: "0.1",
  requestId: "request:model",
  modelAlias: "marea",
  messages: [{ role: "student", content: "Help" }],
  tools: [],
});

function chunk(event: object, sequence: number): object {
  return {
    protocolVersion: "0.1",
    requestId: modelRequest.requestId,
    modelAlias: "marea",
    sequence,
    emittedAt: timestamp,
    ...event,
  };
}

function json(value: object, status: number): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("HTTP model gateway boundary", () => {
  it("streams split NDJSON, accepts the final line, and authenticates with the run lease", async () => {
    const payload = [
      JSON.stringify(chunk({ event: "started" }, 0)),
      JSON.stringify(chunk({ event: "text-delta", delta: "Sí" }, 1)),
      JSON.stringify(chunk({ event: "text-delta", delta: "." }, 2)),
      JSON.stringify(chunk({ event: "text-delta", delta: " Done" }, 3)),
    ].join("\n");
    const bytes = new TextEncoder().encode(payload);
    const splitAt = bytes.indexOf(195) + 1;
    let seen: Request | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const gateway = createHttpModelGateway({
      baseUrl: "https://teacher.example",
      runToken: async () => runToken,
      fetch: async (request) => {
        seen = request;
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      },
    });
    const received: ModelGatewayStreamChunk[] = [];
    for await (const value of gateway.stream(modelRequest, new AbortController().signal))
      received.push(value);
    expect(received.map((value) => value.event)).toEqual([
      "started",
      "text-delta",
      "text-delta",
      "text-delta",
    ]);
    expect(received[1]).toMatchObject({ delta: "Sí" });
    expect((seen as Request | null)?.headers.get("authorization")).toBe(`Bearer ${runToken}`);
  });

  it("stops an unterminated oversized line before reading another chunk", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("x".repeat(131_073)));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.error(new Error("The transport read beyond its bounded buffer."));
      },
    });
    const gateway = createHttpModelGateway({
      baseUrl: "https://teacher.example",
      runToken: async () => runToken,
      fetch: async () =>
        new Response(body, { headers: { "content-type": "application/x-ndjson" } }),
    });
    const received: ModelGatewayStreamChunk[] = [];

    await expect(async () => {
      for await (const value of gateway.stream(modelRequest, new AbortController().signal))
        received.push(value);
    }).rejects.toEqual(new StudentHttpError(200, "response.too-large", false));
    expect(received).toEqual([]);
  });

  it.each([
    [
      "wrong content type",
      new Response("", { headers: { "content-type": "application/json" } }),
      "response.invalid",
    ],
    [
      "empty body",
      new Response(null, { headers: { "content-type": "application/x-ndjson" } }),
      "response.invalid",
    ],
    [
      "blank line",
      new Response("\n", { headers: { "content-type": "application/x-ndjson" } }),
      "response.invalid",
    ],
    [
      "oversized line",
      new Response("x".repeat(131_073), { headers: { "content-type": "application/x-ndjson" } }),
      "response.too-large",
    ],
    [
      "oversized complete line",
      new Response(`${"x".repeat(131_073)}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      }),
      "response.too-large",
    ],
    [
      "exact line bound",
      new Response("x".repeat(131_072), { headers: { "content-type": "application/x-ndjson" } }),
      "response.invalid",
    ],
    [
      "invalid utf8",
      new Response(new Uint8Array([255]), { headers: { "content-type": "application/x-ndjson" } }),
      "response.invalid",
    ],
    [
      "embedded invalid utf8",
      invalidUtf8Response(
        JSON.stringify(chunk({ event: "text-delta", delta: "MARKER" }, 1)),
        "MARKER",
      ),
      "response.invalid",
    ],
    [
      "mismatch",
      new Response(
        `${JSON.stringify({ ...chunk({ event: "started" }, 0), requestId: "request:other" })}\n`,
        { headers: { "content-type": "application/x-ndjson" } },
      ),
      "response.invalid",
    ],
  ])("rejects %s", async (_name, response, code) => {
    const gateway = createHttpModelGateway({
      baseUrl: "https://teacher.example",
      runToken: async () => runToken,
      fetch: async () => response,
    });
    await expect(async () => {
      const received = [];
      for await (const value of gateway.stream(modelRequest, new AbortController().signal))
        received.push(value);
    }).rejects.toEqual(new StudentHttpError(200, code, false));
  });

  it("propagates structured HTTP errors and cancellation", async () => {
    const failed = createHttpModelGateway({
      baseUrl: "https://teacher.example",
      runToken: async () => runToken,
      fetch: async () => json({ error: { code: "server.error", retryable: true } }, 503),
    });
    await expect(async () => {
      const received = [];
      for await (const value of failed.stream(modelRequest, new AbortController().signal))
        received.push(value);
    }).rejects.toEqual(new StudentHttpError(503, "server.error", true));

    const abort = new AbortController();
    abort.abort();
    const cancelled = createHttpModelGateway({
      baseUrl: "https://teacher.example",
      runToken: async () => runToken,
      fetch: async () =>
        new Response(`${JSON.stringify(chunk({ event: "started" }, 0))}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        }),
    });
    const received = [];
    for await (const value of cancelled.stream(modelRequest, abort.signal)) received.push(value);
    expect(received).toHaveLength(1);
  });
});

it.each(["fetch", "body"] as const)(
  "distinguishes %s transport failures from malformed responses and cancellation",
  async (stage) => {
    for (const cancelled of [false, true]) {
      const abort = new AbortController();
      const gateway = createHttpModelGateway({
        baseUrl: "https://teacher.example",
        runToken: () => Promise.resolve(runToken),
        fetch: async () => {
          const fail = () => {
            if (cancelled) abort.abort();
            throw new Error("Private network details");
          };
          if (stage === "fetch") return fail();
          return new Response(new ReadableStream<Uint8Array>({ pull: fail }), {
            headers: { "content-type": "application/x-ndjson" },
          });
        },
      });
      const consume = async () => {
        for await (const value of gateway.stream(modelRequest, abort.signal))
          expect(value).toBeDefined();
      };
      await expect(consume()).rejects.toEqual(
        new StudentHttpError(
          0,
          cancelled
            ? "request.cancelled"
            : stage === "fetch"
              ? "transport.unavailable"
              : "transport.interrupted",
          !cancelled,
        ),
      );
    }
  },
);
