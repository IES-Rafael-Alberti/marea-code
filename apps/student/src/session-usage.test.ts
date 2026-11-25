import type { MareaModelGateway } from "@marea/deepagents-adapter";
import {
  CONTEXT_WINDOW_CAPABILITY,
  ModelGatewayRequestSchema,
  ModelGatewayStreamChunkSchema,
  type ModelGatewayRequest,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { addUsage, meterUsage, StoredUsageSchema, usageGateway } from "./session-usage.js";
import { createFixtureController, FixtureInterface, FixtureServer } from "./student.fixture.js";

const request = ModelGatewayRequestSchema.parse({
  kind: "model-gateway-request",
  protocolVersion: "0.1",
  requestId: "request:usage",
  modelAlias: "marea",
  messages: [{ role: "student", content: "Explain" }],
  tools: [],
});
const base = {
  protocolVersion: "0.1",
  requestId: request.requestId,
  modelAlias: "marea",
  emittedAt: "2026-09-20T10:00:00.000Z",
};

describe("session usage", () => {
  it("adds every call and keeps the input and window of the latest one", () => {
    const first = addUsage(undefined, {
      inputTokens: 100,
      outputTokens: 7,
      contextWindowTokens: 1_000,
    });
    expect(first).toEqual({
      inputTokens: 100,
      outputTokens: 7,
      lastInputTokens: 100,
      contextWindowTokens: 1_000,
    });
    expect(addUsage(first, { inputTokens: 40, outputTokens: 3 })).toStrictEqual({
      inputTokens: 140,
      outputTokens: 10,
      lastInputTokens: 40,
    });
  });

  it("records the usage of a completed call and asks for the window only when supported", async () => {
    const sent: ModelGatewayRequest[] = [];
    const upstream: MareaModelGateway = {
      async *stream(received) {
        await Promise.resolve();
        sent.push(received);
        yield ModelGatewayStreamChunkSchema.parse({ ...base, sequence: 0, event: "started" });
        yield ModelGatewayStreamChunkSchema.parse({
          ...base,
          sequence: 1,
          event: "completed",
          finishReason: "stop",
          usage: { inputTokens: 4, outputTokens: 2 },
        });
      },
    };
    const record = vi.fn(() => Promise.resolve());
    const gateway = usageGateway(upstream, record);
    const drain = async () => {
      const events = [];
      for await (const chunk of gateway.stream(request, new AbortController().signal))
        events.push(chunk.event);
      return events;
    };
    expect(await drain()).toEqual(["started", "completed"]);
    expect(record).toHaveBeenCalledExactlyOnceWith({ inputTokens: 4, outputTokens: 2 });
    gateway.reportWindow(true);
    await drain();
    gateway.reportWindow(false);
    await drain();
    expect(sent.map((received) => received.contextWindow)).toEqual([undefined, true, undefined]);
  });

  it("keeps the totals of the session in its local state", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Synthetic");
    await fixture.localSession.recordUsage({ inputTokens: 10, outputTokens: 1 });
    expect(
      await fixture.localSession.recordUsage({
        inputTokens: 30,
        outputTokens: 2,
        contextWindowTokens: 100,
      }),
    ).toEqual({ inputTokens: 40, outputTokens: 3, lastInputTokens: 30, contextWindowTokens: 100 });
    expect((await fixture.localSession.load()).run?.usage).toEqual({
      inputTokens: 40,
      outputTokens: 3,
      lastInputTokens: 30,
      contextWindowTokens: 100,
    });
  });

  it("needs a session to record usage", async () => {
    const fixture = createFixtureController();
    await expect(
      fixture.localSession.recordUsage({ inputTokens: 1, outputTokens: 1 }),
    ).rejects.toThrow("No local student run exists.");
  });
});

describe("usage across a restart", () => {
  it("shows the stored usage when the session resumes and passes on the server's capabilities", async () => {
    const server = new FixtureServer();
    server.extraCapabilities.push(CONTEXT_WINDOW_CAPABILITY);
    const studentInterface = new FixtureInterface();
    const shown = vi.fn();
    Object.assign(studentInterface, { showUsage: shown });
    const capabilities = vi.fn();
    const fixture = createFixtureController({
      server,
      studentInterface,
      onServerCapabilities: capabilities,
    });
    await fixture.controller.start("Synthetic");
    expect(shown).not.toHaveBeenCalled();
    expect(capabilities).toHaveBeenCalledWith(expect.arrayContaining([CONTEXT_WINDOW_CAPABILITY]));
    await fixture.localSession.recordUsage({ inputTokens: 12, outputTokens: 3 });
    await fixture.controller.start("Synthetic");
    expect(shown).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 12,
      outputTokens: 3,
      lastInputTokens: 12,
    });
  });

  it("shows nothing for a session that has not used the model yet", async () => {
    const studentInterface = new FixtureInterface();
    const shown = vi.fn();
    Object.assign(studentInterface, { showUsage: shown });
    await createFixtureController({ studentInterface }).controller.start("Synthetic");
    expect(shown).not.toHaveBeenCalled();
  });
});

describe("stored usage", () => {
  const valid = { inputTokens: 0, outputTokens: 0, lastInputTokens: 0 };
  it("accepts whole non-negative counts and a positive window", () => {
    expect(StoredUsageSchema.safeParse(valid).success).toBe(true);
    expect(StoredUsageSchema.safeParse({ ...valid, contextWindowTokens: 1 }).success).toBe(true);
  });

  it.each([
    { inputTokens: -1 },
    { outputTokens: -1 },
    { lastInputTokens: -1 },
    { inputTokens: 0.5 },
    { outputTokens: 0.5 },
    { lastInputTokens: 0.5 },
    { contextWindowTokens: 0 },
    { contextWindowTokens: 1.5 },
    { extra: 1 },
  ])("refuses %o", (change) => {
    expect(StoredUsageSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});

describe("usage meter", () => {
  it("shows what each call adds and asks for the window once the server reports it", async () => {
    const sent: ModelGatewayRequest[] = [];
    const upstream: MareaModelGateway = {
      async *stream(received) {
        await Promise.resolve();
        sent.push(received);
        yield ModelGatewayStreamChunkSchema.parse({
          ...base,
          sequence: 0,
          event: "completed",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 1 },
        });
      },
    };
    const total = { inputTokens: 2, outputTokens: 1, lastInputTokens: 2 };
    const record = vi.fn(() => Promise.resolve(total));
    const show = vi.fn();
    const meter = meterUsage(upstream, record, show);
    const drain = async () => {
      const chunks = [];
      for await (const chunk of meter.gateway.stream(request, new AbortController().signal))
        chunks.push(chunk);
      return chunks;
    };
    meter.onServerCapabilities(["marea.runs.events"]);
    await drain();
    meter.onServerCapabilities([CONTEXT_WINDOW_CAPABILITY]);
    await drain();
    expect(sent.map((received) => received.contextWindow)).toEqual([undefined, true]);
    expect(record).toHaveBeenCalledWith({ inputTokens: 2, outputTokens: 1 });
    expect(show).toHaveBeenCalledWith(total);
    await expect(
      (async () => {
        const silent = meterUsage(upstream, record, undefined);
        const chunks = [];
        for await (const chunk of silent.gateway.stream(request, new AbortController().signal))
          chunks.push(chunk);
        expect(chunks).toHaveLength(1);
      })(),
    ).resolves.toBeUndefined();
  });
});

it("resumes a session with usage on an interface without a usage line", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Synthetic");
  await fixture.localSession.recordUsage({ inputTokens: 1, outputTokens: 1 });
  await expect(fixture.controller.start("Synthetic")).resolves.toBeDefined();
});
