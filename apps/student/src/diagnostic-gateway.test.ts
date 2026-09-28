import { expect, it } from "vitest";
import type { MareaModelGateway } from "@marea/deepagents-adapter";
import { ModelGatewayRequestSchema, ModelGatewayStreamChunkSchema } from "@marea/protocol";
import { diagnosticGateway } from "./diagnostic-gateway.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";
const request = ModelGatewayRequestSchema.parse({
  kind: "model-gateway-request",
  protocolVersion: "0.1",
  requestId: "request:diagnostic",
  modelAlias: "marea",
  messages: [{ role: "student", content: "Explain" }],
  tools: [],
});
it.each(["completed", "failed", "interrupted", "exception"] as const)(
  "captures bounded %s diagnostics without changing the stream",
  async (outcome) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Synthetic");
    const base = {
      protocolVersion: "0.1",
      requestId: request.requestId,
      modelAlias: "marea",
      emittedAt: "2026-09-20T10:00:00.000Z",
    };
    const upstream: MareaModelGateway = {
      async *stream() {
        await Promise.resolve();
        yield ModelGatewayStreamChunkSchema.parse({ ...base, sequence: 0, event: "started" });
        for (let index = 0; index < 3; index++)
          yield ModelGatewayStreamChunkSchema.parse({
            ...base,
            sequence: index + 1,
            event: "text-delta",
            delta: "x".repeat(8192),
          });
        if (outcome === "exception") throw new Error("Synthetic failure");
        if (outcome === "completed")
          yield ModelGatewayStreamChunkSchema.parse({
            ...base,
            sequence: 4,
            event: "completed",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        if (outcome === "failed")
          yield ModelGatewayStreamChunkSchema.parse({
            ...base,
            sequence: 4,
            event: "failed",
            code: "inference-failed",
            message: "safe error",
            retryable: true,
          });
      },
    };
    const gateway = diagnosticGateway(upstream, fixture.localSession, new FixtureIds());
    const consume = async () => {
      const chunks = [];
      for await (const chunk of gateway.stream(request, new AbortController().signal))
        chunks.push(chunk);
      return chunks;
    };
    if (outcome === "exception") await expect(consume()).rejects.toThrow("Synthetic failure");
    else expect((await consume()).filter((chunk) => chunk.event === "text-delta")).toHaveLength(3);
    const events = await fixture.localSession.pendingEvents(128);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventType: "model-diagnostic",
      phase: "request",
      status: "started",
      truncated: false,
    });
    expect(events[1]).toMatchObject({
      eventType: "model-diagnostic",
      phase: "response",
      status: outcome === "exception" ? "failed" : outcome,
      truncated: true,
    });
    if (events[1]?.eventType === "model-diagnostic") expect(events[1].content).toHaveLength(16_384);
  },
);
it("records normalized tool calls and an aborted response without raw transport secrets", async () => {
  const f = createFixtureController();
  await f.controller.start("Diagnostics");
  const controller = new AbortController();
  const gateway = diagnosticGateway(
    {
      async *stream() {
        await Promise.resolve();
        yield ModelGatewayStreamChunkSchema.parse({
          protocolVersion: "0.1",
          requestId: request.requestId,
          modelAlias: "marea",
          emittedAt: "2026-09-20T10:00:00.000Z",
          sequence: 0,
          event: "tool-call",
          callId: "call:one",
          tool: "read_file",
          arguments: { path: "main.ts" },
        });
        controller.abort(new Error("stopped"));
        controller.signal.throwIfAborted();
      },
    },
    f.localSession,
    new FixtureIds(),
  );
  const rich = ModelGatewayRequestSchema.parse({
    ...request,
    messages: [{ role: "student", content: "x".repeat(20000) }],
    tools: [{ name: "read_file", description: "Read", inputSchema: {} }],
  });
  const consume = async () => {
    for await (const chunk of gateway.stream(rich, controller.signal))
      expect(chunk.event).toBe("tool-call");
  };
  await expect(consume()).rejects.toThrow("stopped");
  const events = await f.localSession.pendingEvents(128);
  expect(events[0]).toMatchObject({ truncated: true });
  expect(events[1]).toMatchObject({
    status: "interrupted",
    truncated: false,
    content: '\n{"tool":"read_file","arguments":{"path":"main.ts"}}\n',
  });
});
it.each([16384, 16385])(
  "preserves exact request/response bounds at %s characters and tool identities",
  async (size) => {
    const f = createFixtureController();
    await f.controller.start("Exact diagnostics");
    const tool = { name: "read_file", description: "Read", inputSchema: {} };
    const overhead = JSON.stringify(
      { messages: [{ role: "student", content: "" }], tools: [tool.name] },
      null,
      2,
    ).length;
    const input = {
      ...request,
      messages: [{ role: "student" as const, content: "r".repeat(size - overhead) }],
      tools: [tool],
    };
    const gateway = diagnosticGateway(
      {
        async *stream() {
          await Promise.resolve();
          for (const delta of ["s".repeat(8192), "s".repeat(size - 8192)])
            yield ModelGatewayStreamChunkSchema.parse({
              protocolVersion: "0.1",
              requestId: request.requestId,
              modelAlias: "marea",
              emittedAt: "2026-09-20T10:00:00.000Z",
              sequence: 0,
              event: "text-delta",
              delta,
            });
        },
      },
      f.localSession,
      new FixtureIds(),
    );
    for await (const chunk of gateway.stream(input, new AbortController().signal))
      expect(chunk.event).toBe("text-delta");
    const events = await f.localSession.pendingEvents(128);
    expect(events).toMatchObject([
      {
        content: JSON.stringify({ messages: input.messages, tools: ["read_file"] }, null, 2).slice(
          0,
          16384,
        ),
        truncated: size > 16384,
      },
      { content: "s".repeat(16384), truncated: size > 16384 },
    ]);
  },
);
it("records short failures exactly and ignores transport lifecycle chunks in response text", async () => {
  const f = createFixtureController();
  await f.controller.start("Failure diagnostic");
  const base = {
    protocolVersion: "0.1",
    requestId: request.requestId,
    modelAlias: "marea",
    emittedAt: "2026-09-20T10:00:00.000Z",
  };
  const gateway = diagnosticGateway(
    {
      async *stream() {
        await Promise.resolve();
        yield ModelGatewayStreamChunkSchema.parse({ ...base, sequence: 0, event: "started" });
        yield ModelGatewayStreamChunkSchema.parse({
          ...base,
          sequence: 1,
          event: "text-delta",
          delta: "prefix",
        });
        yield ModelGatewayStreamChunkSchema.parse({
          ...base,
          sequence: 2,
          event: "failed",
          code: "inference-failed",
          message: "safe",
          retryable: true,
        });
      },
    },
    f.localSession,
    new FixtureIds(),
  );
  for await (const chunk of gateway.stream(
    { ...request, tools: [{ name: "read_file", description: "Read", inputSchema: {} }] },
    new AbortController().signal,
  ))
    expect(chunk.requestId).toBe(request.requestId);
  const events = await f.localSession.pendingEvents(128);
  expect(events[0]).toMatchObject({
    content: JSON.stringify({ messages: request.messages, tools: ["read_file"] }, null, 2),
    truncated: false,
  });
  expect(events[1]).toMatchObject({
    content: "prefix\ninference-failed\n",
    truncated: false,
    status: "failed",
  });
});
