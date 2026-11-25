import { describe, expect, it } from "vitest";

import { TURN_DIAGNOSTICS_CAPABILITY, TurnDiagnosticEventSchema } from "./events.js";
import { ModelGatewayRequestSchema, ModelGatewayStreamChunkSchema } from "./model-gateway.js";

const text = (length: number) => "x".repeat(length);
const exception = { name: "TypeError", message: "bad input" };
const diagnostic = {
  eventId: "event-1",
  sequence: 1,
  occurredAt: "2026-09-03T10:00:00Z",
  eventType: "turn-diagnostic",
  messageId: "message-1",
  category: "unexpected/client.TypeError",
  retryable: false,
  exception,
  causes: [exception],
  stack: "TypeError: bad input",
  client: { version: "0.1.0-preview.44", platform: "win32-x64" },
} as const;

const accepts = (overrides: object) =>
  TurnDiagnosticEventSchema.safeParse({ ...diagnostic, ...overrides }).success;

describe("turn diagnostic event", () => {
  it("is offered behind its own capability", () => {
    expect(TURN_DIAGNOSTICS_CAPABILITY).toBe("marea.runs.turn-diagnostics");
  });

  it("accepts every field at its bound and the optional request and model response", () => {
    expect(
      accepts({
        category: text(128),
        exception: { name: text(128), message: text(2_048) },
        causes: Array.from({ length: 8 }, () => ({ name: "E", message: "" })),
        stack: text(8_192),
        requestId: "request-1",
        modelResponse: text(16_384),
        client: { version: text(64), platform: text(64) },
      }),
    ).toBe(true);
    expect(accepts({ category: "c", causes: [], stack: "", modelResponse: "" })).toBe(true);
    expect(accepts({ client: { version: "v", platform: "p" } })).toBe(true);
  });

  it.each([
    ["an empty category", { category: "" }],
    ["a long category", { category: text(129) }],
    ["an unnamed exception", { exception: { name: "", message: "" } }],
    ["a long exception name", { exception: { name: text(129), message: "" } }],
    ["a long exception message", { exception: { name: "E", message: text(2_049) } }],
    ["an exception with more fields", { exception: { ...exception, code: "x" } }],
    ["too many causes", { causes: Array.from({ length: 9 }, () => exception) }],
    ["a long stack", { stack: text(8_193) }],
    ["a long model response", { modelResponse: text(16_385) }],
    ["an empty client version", { client: { version: "", platform: "p" } }],
    ["a long client version", { client: { version: text(65), platform: "p" } }],
    ["an empty platform", { client: { version: "v", platform: "" } }],
    ["a long platform", { client: { version: "v", platform: text(65) } }],
    ["a client with more fields", { client: { version: "v", platform: "p", os: "x" } }],
    ["another event type", { eventType: "turn-failed" }],
  ])("refuses %s", (_label, overrides) => {
    expect(accepts(overrides)).toBe(false);
  });
});

const request = {
  kind: "model-gateway-request",
  protocolVersion: "0.1",
  requestId: "request-model-1",
  modelAlias: "marea",
  messages: [{ role: "student", content: "Help." }],
  tools: [],
} as const;

const toolCall = (repair: object) =>
  ModelGatewayStreamChunkSchema.safeParse({
    protocolVersion: "0.1",
    requestId: "request-model-1",
    modelAlias: "marea",
    sequence: 1,
    emittedAt: "2026-09-03T10:00:00Z",
    event: "tool-call",
    callId: "call-1",
    tool: "grep",
    arguments: {},
    repair,
  }).success;

describe("tool-call repair detail", () => {
  it("is asked for only with diagnostics set to true", () => {
    expect(ModelGatewayRequestSchema.safeParse({ ...request, diagnostics: true }).success).toBe(
      true,
    );
    expect(ModelGatewayRequestSchema.safeParse({ ...request, diagnostics: false }).success).toBe(
      false,
    );
  });

  it("accepts repair detail at its bounds", () => {
    expect(
      toolCall({
        causes: Array.from({ length: 8 }, () => text(64)),
        rawName: text(256),
        rawArguments: text(4_096),
      }),
    ).toBe(true);
    expect(toolCall({ causes: ["m"], rawName: null, rawArguments: "" })).toBe(true);
  });

  it.each([
    ["no causes", { causes: [], rawName: null, rawArguments: "" }],
    [
      "too many causes",
      { causes: Array.from({ length: 9 }, () => "m"), rawName: null, rawArguments: "" },
    ],
    ["an empty cause", { causes: [""], rawName: null, rawArguments: "" }],
    ["a long cause", { causes: [text(65)], rawName: null, rawArguments: "" }],
    ["a long raw name", { causes: ["m"], rawName: text(257), rawArguments: "" }],
    ["long raw arguments", { causes: ["m"], rawName: null, rawArguments: text(4_097) }],
    ["more fields", { causes: ["m"], rawName: null, rawArguments: "", extra: "x" }],
  ])("refuses repair detail with %s", (_label, repair) => {
    expect(toolCall(repair)).toBe(false);
  });
});
