import { ModelStreamError } from "@marea/deepagents-adapter";
import { TURN_DIAGNOSTICS_CAPABILITY } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "./contracts.js";
import { createFixtureController, FixtureAgent, FixtureServer } from "./student.fixture.js";
import { clientIdentity } from "./turn-diagnostic-report.js";

class FailingAgent extends FixtureAgent {
  override async *streamMessage(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield { type: "assistant-text-delta", text: "Empiezo" };
    throw new ModelStreamError({
      code: "invalid-response",
      message: "The inference provider returned an invalid tool call.",
      retryable: false,
    });
  }
}

function setup(
  serverStores: boolean,
  log = { path: "/state/turn-failures.jsonl", append: vi.fn() },
) {
  const server = new FixtureServer();
  if (serverStores) server.extraCapabilities.push(TURN_DIAGNOSTICS_CAPABILITY);
  const onServerSupport = vi.fn();
  const fixture = createFixtureController({
    agent: new FailingAgent(),
    server,
    diagnostics: {
      client: { version: "0.1.0-preview.44", platform: "win32-x64" },
      log,
      lastModelResponse: () => ({ requestId: "request:last", content: '{"tool":"grep"}' }),
      onServerSupport,
    },
  });
  return { fixture, log, onServerSupport };
}

const events = (fixture: ReturnType<typeof createFixtureController>) => [
  ...fixture.server.events.values(),
];

async function fail(subject: ReturnType<typeof setup>): Promise<void> {
  await subject.fixture.controller.start("Synthetic project");
  await expect(
    subject.fixture.controller.sendMessage("message:1", "Busca", new AbortController().signal),
  ).rejects.toThrow();
}

describe("diagnostics of a failed turn", () => {
  it("keeps one undelivered diagnostic per failed message while the server is unreachable", async () => {
    const subject = setup(true);
    await subject.fixture.controller.start("Synthetic project");
    subject.fixture.server.appendRunEvents = () => Promise.reject(new Error("offline"));

    for (const messageId of ["message:1", "message:2"]) {
      await expect(
        subject.fixture.controller.sendMessage(messageId, "Busca", new AbortController().signal),
      ).rejects.toThrow();
    }

    const queued = subject.fixture.state.state.run?.outbox ?? [];
    const diagnostics = queued.filter((entry) => entry.value.eventType === "turn-diagnostic");
    expect(diagnostics.map((entry) => entry.key)).toEqual([
      expect.stringContaining("message:1"),
      expect.stringContaining("message:2"),
    ]);
  });

  it("names the origin in turn-failed and stores the detail with the session", async () => {
    const subject = setup(true);
    await fail(subject);
    expect(subject.onServerSupport).toHaveBeenCalledWith(true);
    expect(events(subject.fixture)).toContainEqual(
      expect.objectContaining({
        eventType: "turn-failed",
        category: "request-failed/provider.invalid-response",
      }),
    );
    expect(events(subject.fixture)).toContainEqual(
      expect.objectContaining({
        eventType: "turn-diagnostic",
        messageId: "message:1",
        category: "request-failed/provider.invalid-response",
        exception: {
          name: "ModelStreamError",
          message: "The Marea model gateway reported a failed stream.",
        },
        client: { version: "0.1.0-preview.44", platform: "win32-x64" },
        requestId: "request:last",
        modelResponse: '{"tool":"grep"}',
      }),
    );
    expect(subject.log.append).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message:1",
        category: "request-failed/provider.invalid-response",
      }),
    );
  });

  it("keeps only the local copy with a server that does not store diagnostics", async () => {
    const subject = setup(false);
    await fail(subject);
    expect(subject.onServerSupport).toHaveBeenCalledWith(false);
    expect(events(subject.fixture).some((event) => event.eventType === "turn-diagnostic")).toBe(
      false,
    );
    expect(subject.log.append).toHaveBeenCalledOnce();
  });

  it("records one diagnostic per failed attempt", async () => {
    const subject = setup(true);
    await fail(subject);
    await expect(
      subject.fixture.controller.sendMessage("message:2", "Otra", new AbortController().signal),
    ).rejects.toThrow();
    expect(
      events(subject.fixture)
        .filter((event) => event.eventType === "turn-diagnostic")
        .map((event) => ("messageId" in event ? event.messageId : null)),
    ).toEqual(["message:1", "message:2"]);
  });

  it("names the client by version and platform", () => {
    expect(clientIdentity("0.1.0-preview.44")).toEqual({
      version: "0.1.0-preview.44",
      platform: `${process.platform}-${process.arch}`,
    });
  });

  it("never lets a failing local copy change the failure", async () => {
    const subject = setup(true, {
      path: "/state/turn-failures.jsonl",
      append: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    await fail(subject);
    expect(events(subject.fixture).some((event) => event.eventType === "turn-diagnostic")).toBe(
      true,
    );
  });
});

type ModelResponse = { readonly requestId: string; readonly content: string } | null;

it("sends no diagnostic when the client records none, even to a server that stores them", async () => {
  const server = new FixtureServer();
  server.extraCapabilities.push(TURN_DIAGNOSTICS_CAPABILITY);
  const fixture = createFixtureController({ agent: new FailingAgent(), server });
  await fixture.controller.start("Synthetic project");
  await expect(
    fixture.controller.sendMessage("message:1", "Busca", new AbortController().signal),
  ).rejects.toMatchObject({ cause: { streamCode: "invalid-response" } });
  const recorded = [
    ...fixture.server.events.values(),
    ...(await fixture.localSession.pendingEvents(1_000)),
  ];
  expect(recorded.some((event) => event.eventType === "turn-failed")).toBe(true);
  expect(recorded.some((event) => event.eventType === "turn-diagnostic")).toBe(false);
});

describe("diagnostics without every optional source", () => {
  const sources: readonly [string, (() => ModelResponse) | undefined, string | undefined][] = [
    ["no model exchange yet", () => null, undefined],
    ["no model tracker", undefined, undefined],
    [
      "an unusable request identity",
      () => ({ requestId: "not a request id!", content: "partial" }),
      "partial",
    ],
  ];
  it.each(sources)("still records the failure with %s", async (_label, last, response) => {
    const server = new FixtureServer();
    server.extraCapabilities.push(TURN_DIAGNOSTICS_CAPABILITY);
    const fixture = createFixtureController({
      agent: new FailingAgent(),
      server,
      diagnostics: {
        client: { version: "1.0.0", platform: "linux-x64" },
        log: { path: "/state/turn-failures.jsonl", append: vi.fn() },
        ...(last === undefined ? {} : { lastModelResponse: last }),
      },
    });
    await fixture.controller.start("Synthetic project");
    await expect(
      fixture.controller.sendMessage("message:1", "Busca", new AbortController().signal),
    ).rejects.toThrow();
    const diagnostic = [...fixture.server.events.values()].find(
      (event) => event.eventType === "turn-diagnostic",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic).not.toHaveProperty("requestId");
    if (response === undefined) expect(diagnostic).not.toHaveProperty("modelResponse");
    else expect(diagnostic).toMatchObject({ modelResponse: response });
  });
});
