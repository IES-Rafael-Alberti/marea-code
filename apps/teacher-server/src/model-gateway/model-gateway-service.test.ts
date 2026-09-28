import {
  InferenceProviderError,
  type InferenceCancellation,
  type InferenceProvider,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "@marea/plugin-api";
import { ModelGatewayRequestSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ModelGatewayRetryScheduler } from "./contracts.js";
import { ModelGatewayService } from "./model-gateway-service.js";

interface ProviderAttempt {
  readonly events: readonly InferenceProviderEvent[];
  readonly error?: Error;
}

class ScriptedProvider implements InferenceProvider {
  public readonly requests: InferenceProviderRequest[] = [];
  public readonly cancellations: InferenceCancellation[] = [];
  public attempts = 0;

  public constructor(private readonly scripts: readonly ProviderAttempt[]) {}

  public async *stream(
    request: InferenceProviderRequest,
    cancellation: InferenceCancellation,
  ): AsyncIterable<InferenceProviderEvent> {
    await Promise.resolve();
    const script = this.scripts[this.attempts];
    this.attempts += 1;
    this.requests.push(request);
    this.cancellations.push(cancellation);
    if (script === undefined) throw new Error("Missing provider script.");
    for (const event of script.events) yield event;
    if (script.error !== undefined) throw script.error;
  }
}

const request = ModelGatewayRequestSchema.parse({
  kind: "model-gateway-request",
  protocolVersion: "0.1",
  requestId: "request:gateway",
  modelAlias: "marea",
  messages: [
    { role: "system", content: "Be concise." },
    { role: "student", content: "Change the file." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          callId: "call:one",
          tool: "confirm_change",
          arguments: { path: "src/example.ts" },
        },
      ],
    },
    {
      role: "tool",
      callId: "call:one",
      tool: "confirm_change",
      content: "approved",
    },
  ],
  tools: [
    {
      name: "confirm_change",
      description: "Confirm a workspace change.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
});

function providerError(code: "authentication-failed" | "unavailable", retryable: boolean): Error {
  return new InferenceProviderError({ code, message: `safe:${code}`, retryable });
}

function createService(
  provider: InferenceProvider,
  wait: ModelGatewayRetryScheduler["wait"] = () => Promise.resolve(),
): ModelGatewayService {
  return new ModelGatewayService({
    clock: { now: () => "2026-09-03T08:00:00.000Z" },
    retry: { wait },
    route: { provider, upstreamModel: "private-upstream-model" },
  });
}

async function collect(service: ModelGatewayService, signal = new AbortController().signal) {
  const chunks = [];
  for await (const chunk of service.stream(request, signal)) chunks.push(chunk);
  return chunks;
}

describe("model gateway service", () => {
  it("translates the private provider stream into public marea chunks", async () => {
    const provider = new ScriptedProvider([
      {
        events: [
          { type: "text-delta", text: "Ready." },
          {
            type: "tool-call",
            callId: "call:two",
            name: "confirm_change",
            arguments: { path: "src/new.ts" },
          },
          { type: "usage", inputTokens: 8, outputTokens: 3 },
          { type: "completed", finishReason: "tool-call" },
        ],
      },
    ]);

    const chunks = await collect(createService(provider));

    expect(chunks.map((chunk) => chunk.event)).toEqual([
      "started",
      "text-delta",
      "tool-call",
      "completed",
    ]);
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2, 3]);
    expect(chunks[3]).toMatchObject({
      finishReason: "tool-call",
      usage: { inputTokens: 8, outputTokens: 3 },
    });
    expect(provider.requests).toEqual([
      {
        messages: [
          { content: "Be concise.", role: "system" },
          { content: "Change the file.", role: "user" },
          {
            content: "",
            role: "assistant",
            toolCalls: [
              {
                arguments: { path: "src/example.ts" },
                callId: "call:one",
                name: "confirm_change",
              },
            ],
          },
          { content: "approved", role: "tool", toolCallId: "call:one" },
        ],
        requestId: "request:gateway",
        tools: [
          {
            description: "Confirm a workspace change.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
            name: "confirm_change",
          },
        ],
        upstreamModel: "private-upstream-model",
      },
    ]);
    expect(JSON.stringify(chunks)).not.toContain("private-upstream-model");
  });

  it("retries a retryable failure only before the first provider event", async () => {
    const wait = vi.fn(() => Promise.resolve());
    const firstError = providerError("unavailable", true);
    const provider = new ScriptedProvider([
      { events: [], error: firstError },
      {
        events: [
          { type: "usage", inputTokens: 1, outputTokens: 2 },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const chunks = await collect(createService(provider, wait));

    expect(provider.attempts).toBe(2);
    expect(wait).toHaveBeenCalledWith(firstError, expect.any(AbortSignal));
    expect(chunks.map((chunk) => chunk.event)).toEqual(["started", "completed"]);
  });

  it("offers manual recovery without automatically retrying partial content", async () => {
    const wait = vi.fn(() => Promise.resolve());
    const provider = new ScriptedProvider([
      {
        events: [{ type: "text-delta", text: "Partial" }],
        error: providerError("unavailable", true),
      },
    ]);

    const chunks = await collect(createService(provider, wait));

    expect(provider.attempts).toBe(1);
    expect(wait).not.toHaveBeenCalled();
    expect(chunks.at(-1)).toMatchObject({
      code: "unavailable",
      event: "failed",
      retryable: true,
      sequence: 2,
    });
  });

  it("returns safe terminal failures for provider and contract errors", async () => {
    const rejected = await collect(
      createService(
        new ScriptedProvider([
          { events: [], error: providerError("authentication-failed", false) },
        ]),
      ),
    );
    const missingUsage = await collect(
      createService(
        new ScriptedProvider([{ events: [{ type: "completed", finishReason: "stop" }] }]),
      ),
    );
    const incomplete = await collect(createService(new ScriptedProvider([{ events: [] }])));
    const generic = await collect(
      createService(new ScriptedProvider([{ events: [], error: new Error("private detail") }])),
    );
    const exhausted = await collect(
      createService(
        new ScriptedProvider([
          { events: [], error: providerError("unavailable", true) },
          { events: [], error: providerError("unavailable", true) },
        ]),
      ),
    );
    const retryFailed = await collect(
      createService(
        new ScriptedProvider([{ events: [], error: providerError("unavailable", true) }]),
        () => Promise.reject(new Error("private scheduler failure")),
      ),
    );

    expect(rejected.at(-1)).toMatchObject({
      code: "authentication-failed",
      message: "safe:authentication-failed",
      retryable: false,
    });
    expect(missingUsage.at(-1)).toMatchObject({
      code: "inference-failed",
      message: "The inference request failed.",
      retryable: false,
    });
    expect(incomplete.at(-1)).toMatchObject({
      code: "inference-failed",
      event: "failed",
      retryable: false,
      sequence: 1,
    });
    expect(generic.at(-1)).toMatchObject({
      code: "inference-failed",
      message: "The inference request failed.",
      retryable: false,
    });
    expect(exhausted.at(-1)).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(retryFailed.at(-1)).toMatchObject({
      code: "inference-failed",
      retryable: false,
    });
  });

  it("exposes live cancellation and unregisters subscribed listeners", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let notificationCount = 0;
    const provider: InferenceProvider = {
      async *stream(_request, cancellation): AsyncIterable<InferenceProviderEvent> {
        await Promise.resolve();
        expect(cancellation.aborted).toBe(false);
        const unsubscribe = cancellation.subscribe(() => {
          notificationCount += 1;
        });
        controller.abort();
        expect(cancellation.aborted).toBe(true);
        unsubscribe();
        controller.abort();
        yield { type: "usage", inputTokens: 0, outputTokens: 0 };
        yield { type: "completed", finishReason: "length" };
      },
    };

    await collect(createService(provider), controller.signal);

    expect(notificationCount).toBe(1);
    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
