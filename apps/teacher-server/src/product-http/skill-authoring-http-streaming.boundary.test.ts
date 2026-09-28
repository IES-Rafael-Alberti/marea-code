import { ProtocolErrorResponseSchema, SkillAuthoringReadResponseSchema } from "@marea/protocol";
import * as z from "zod";

import {
  BASE_URL,
  TEACHER_COOKIE,
  bodyRequest,
  createRouteApp,
  validReadRequest,
} from "./skill-authoring-http.fixture.js";
import { parseSkillAuthoringJson } from "./skill-authoring-http.boundary.js";
import { describe, expect, it } from "vitest";

const cookie = `marea_teacher_session=${TEACHER_COOKIE}`;

async function protocolErrorSummary(response: Response): Promise<{
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
}> {
  const body = ProtocolErrorResponseSchema.parse(await response.json());
  return { code: body.error.code, retryable: body.error.retryable, status: response.status };
}

describe("skill authoring HTTP streaming boundary", () => {
  it("handles streaming request errors and hostile chunk shapes", async () => {
    const { app } = createRouteApp();
    const streamRequest = (stream: ReadableStream<Uint8Array>): Request =>
      new Request(`${BASE_URL}/api/v1/dashboard/skill-authoring/read`, {
        body: stream,
        headers: { "content-type": "application/json", cookie, host: "teacher.test" },
        method: "POST",
        duplex: "half",
      } as RequestInit & { readonly duplex: "half" });
    const errorStream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("private stream error");
      },
    });
    await expect(
      protocolErrorSummary(await app.fetch(streamRequest(errorStream))),
    ).resolves.toEqual({
      code: "server.error",
      retryable: true,
      status: 500,
    });

    let manyChunksRead = 0;
    const manyChunks = new ReadableStream<Uint8Array>({
      pull(controller) {
        manyChunksRead += 1;
        controller.enqueue(new Uint8Array([32]));
        if (manyChunksRead === 4_097) controller.close();
      },
    });
    await expect(protocolErrorSummary(await app.fetch(streamRequest(manyChunks)))).resolves.toEqual(
      {
        code: "request.invalid",
        retryable: false,
        status: 413,
      },
    );
    let tooManyBytesCancelled = false;
    const tooManyBytes = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(65 * 1_024));
      },
      cancel() {
        tooManyBytesCancelled = true;
        throw new Error("cancel failed");
      },
    });
    await expect(
      protocolErrorSummary(await app.fetch(streamRequest(tooManyBytes))),
    ).resolves.toEqual({
      code: "request.invalid",
      retryable: false,
      status: 413,
    });
    expect(tooManyBytesCancelled).toBe(true);

    let malformedChunkCancelled = false;
    const malformedChunkStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3]));
        controller.enqueue(new Uint8Array([0x28]));
      },
      cancel() {
        malformedChunkCancelled = true;
      },
    });
    await expect(
      protocolErrorSummary(await app.fetch(streamRequest(malformedChunkStream))),
    ).resolves.toEqual({
      code: "request.invalid",
      retryable: false,
      status: 400,
    });
    expect(malformedChunkCancelled).toBe(true);

    const requestSchema = z.object({ requestId: z.string() });
    const boundedBody = JSON.stringify({ requestId: "request:bounded" });
    const boundedBytes = new TextEncoder().encode(boundedBody).byteLength;
    await expect(
      parseSkillAuthoringJson(
        bodyRequest("/ignored", boundedBody, { contentLength: String(boundedBytes) }),
        requestSchema,
        boundedBytes,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      parseSkillAuthoringJson(
        bodyRequest("/ignored", boundedBody, { contentLength: String(boundedBytes - 1) }),
        requestSchema,
        64 * 1_024,
      ),
    ).resolves.toMatchObject({ ok: false });

    const unicodeBody = JSON.stringify({ text: "é" });
    const unicodeBytes = new TextEncoder().encode(unicodeBody);
    const unicodeSplit = unicodeBytes.findIndex((value) => value === 0xc3);
    const unicodeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(unicodeBytes.slice(0, unicodeSplit + 1));
        controller.enqueue(unicodeBytes.slice(unicodeSplit + 1));
        controller.close();
      },
    });
    await expect(
      parseSkillAuthoringJson(
        streamRequest(unicodeStream),
        z.object({ text: z.string() }),
        unicodeBytes.byteLength,
      ),
    ).resolves.toMatchObject({ ok: true });

    let fakeReadCount = 0;
    let released = false;
    const fakeRequest = {
      body: {
        getReader: () => ({
          read: () => {
            if (fakeReadCount++ === 0) {
              return Promise.resolve({ done: false, value: new TextEncoder().encode(boundedBody) });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          releaseLock: () => {
            released = true;
          },
        }),
      },
      headers: new Headers({ "content-type": "application/json" }),
    } as never;
    await expect(
      parseSkillAuthoringJson(fakeRequest, requestSchema, 64 * 1_024),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(released).toBe(true);

    const exactChunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(boundedBody));
        for (let index = 1; index < 4_096; index += 1) controller.enqueue(new Uint8Array());
        controller.close();
      },
    });
    await expect(
      parseSkillAuthoringJson(streamRequest(exactChunks), requestSchema, 64 * 1_024),
    ).resolves.toMatchObject({
      ok: true,
    });

    const overChunkLimit = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(boundedBody));
        for (let index = 1; index <= 4_096; index += 1) controller.enqueue(new Uint8Array());
        controller.close();
      },
    });
    await expect(
      parseSkillAuthoringJson(streamRequest(overChunkLimit), requestSchema, 64 * 1_024),
    ).resolves.toMatchObject({
      ok: false,
    });
  });

  it("parses empty and valid streaming bodies directly", async () => {
    const empty = await parseSkillAuthoringJson(
      bodyRequest("/ignored", null),
      SkillAuthoringReadResponseSchema,
      64 * 1_024,
    );
    expect(empty.ok).toBe(false);

    const text = JSON.stringify(validReadRequest());
    const encoded = new TextEncoder().encode(text);
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        const splitAt = encoded.findIndex((value) => value > 0x7f);
        if (splitAt === -1) {
          controller.enqueue(encoded);
        } else {
          controller.enqueue(encoded.slice(0, splitAt));
          controller.enqueue(encoded.slice(splitAt));
        }
        controller.close();
      },
    });
    const parsed = await parseSkillAuthoringJson(
      new Request(`${BASE_URL}/ignored`, {
        body: split,
        headers: { "content-type": "application/json", host: "teacher.test" },
        method: "POST",
        duplex: "half",
      } as RequestInit & { readonly duplex: "half" }),
      z.object({ requestId: z.string() }),
      64 * 1_024,
    );
    expect(parsed.ok).toBe(true);
  });

  it("does not accept valid JSON when the final UTF-8 sequence is incomplete", async () => {
    const requestSchema = z.object({ requestId: z.string() });
    const validJson = JSON.stringify({ requestId: "request:valid-prefix" });
    const validBytes = new TextEncoder().encode(validJson);
    const trailingIncomplete = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(validBytes);
        controller.enqueue(new Uint8Array([0xc3]));
        controller.close();
      },
    });

    const parsed = await parseSkillAuthoringJson(
      new Request(`${BASE_URL}/ignored`, {
        body: trailingIncomplete,
        headers: { "content-type": "application/json", host: "teacher.test" },
        method: "POST",
        duplex: "half",
      } as RequestInit & { readonly duplex: "half" }),
      requestSchema,
      validBytes.byteLength + 1,
    );

    expect(parsed.ok).toBe(false);
  });

  it("returns invalid input for malformed JSON after a stream closes", async () => {
    const requestSchema = z.any();
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"requestId":'));
        controller.enqueue(new TextEncoder().encode('"request:malformed"'));
        controller.close();
      },
    });

    const parsed = await parseSkillAuthoringJson(
      new Request(`${BASE_URL}/ignored`, {
        body: malformed,
        headers: { "content-type": "application/json", host: "teacher.test" },
        method: "POST",
        duplex: "half",
      } as RequestInit & { readonly duplex: "half" }),
      requestSchema,
      64 * 1_024,
    );

    expect(parsed.ok).toBe(false);
  });

  it("consumes all chunks before accepting a body at stream termination", async () => {
    const requestSchema = z.object({ requestId: z.string() });
    const validJson = JSON.stringify({ requestId: "request:complete" });
    const validBytes = new TextEncoder().encode(validJson);
    let reads = 0;
    const complete = new ReadableStream<Uint8Array>({
      pull(controller) {
        const split = Math.floor(validBytes.byteLength / 2);
        if (reads === 0) controller.enqueue(validBytes.slice(0, split));
        else if (reads === 1) controller.enqueue(validBytes.slice(split));
        else controller.close();
        reads += 1;
      },
    });

    const parsed = await parseSkillAuthoringJson(
      new Request(`${BASE_URL}/ignored`, {
        body: complete,
        headers: { "content-type": "application/json", host: "teacher.test" },
        method: "POST",
        duplex: "half",
      } as RequestInit & { readonly duplex: "half" }),
      requestSchema,
      validBytes.byteLength,
    );

    expect(parsed).toEqual({ ok: true, value: { requestId: "request:complete" } });
    expect(reads).toBe(3);
  });
});
