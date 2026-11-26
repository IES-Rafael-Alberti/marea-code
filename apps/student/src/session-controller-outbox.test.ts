import type { AppendRunEventsRequest } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { FailureLog } from "./failure-log.boundary.js";
import { StudentHttpError } from "./http-error.js";
import { createFixtureController } from "./student.fixture.js";

type Fixture = ReturnType<typeof createFixtureController>;

function fixtureWithLog() {
  const records: Parameters<FailureLog["append"]>[0][] = [];
  const fixture = createFixtureController({
    diagnostics: {
      client: { version: "1.0.0", platform: "test" },
      log: {
        path: "turn-failures.jsonl",
        append: (record) => {
          records.push(record);
          return Promise.resolve();
        },
      },
    },
  });
  return {
    fixture,
    records: { setAside: () => records.filter((r) => r.kind === "event-set-aside") },
  };
}

/** The server refuses, permanently, every delivery that carries an event of `type`. */
function refuse(fixture: Fixture, type: string, error = rejection()): AppendRunEventsRequest[] {
  const seen: AppendRunEventsRequest[] = [];
  const original = fixture.server.appendRunEvents.bind(fixture.server);
  fixture.server.appendRunEvents = (token, request) => {
    seen.push(request);
    if (request.events.some((event) => event.eventType === type)) return Promise.reject(error);
    return original(token, request);
  };
  return seen;
}

function rejection(status = 409, code = "request.invalid", retryable = false): StudentHttpError {
  return new StudentHttpError(status, code, retryable);
}

function durableSequences(fixture: Fixture): number[] {
  return [...fixture.server.events.keys()].sort((a, b) => a - b);
}

describe("outbox delivery of a permanently refused event", () => {
  it("sets only the refused event aside and keeps delivering the rest without a gap", async () => {
    const { fixture, records } = fixtureWithLog();
    await fixture.controller.start("Project One");
    const seen = refuse(fixture, "assistant-message");

    await fixture.controller.sendMessage("message:1", "Write notes.", new AbortController().signal);
    await fixture.controller.sendMessage("message:2", "Again.", new AbortController().signal);

    const stored = [...fixture.server.events.values()];
    expect(stored.some((event) => event.eventType === "assistant-message")).toBe(false);
    expect(stored.filter((event) => event.eventType === "student-message")).toHaveLength(2);
    const sequences = durableSequences(fixture);
    expect(sequences).toEqual(sequences.map((_, index) => (sequences[0] ?? 0) + index));
    const run = (await fixture.controller.pendingTurn()) ?? null;
    expect(run).toBeNull();
    const local = fixture.state.state.run;
    expect(local?.outbox).toEqual([]);
    expect(local?.pendingDelivery ?? null).toBeNull();
    expect(local?.nextSequence).toBe((sequences.at(-1) ?? 0) + 1);
    expect(records.setAside()).toHaveLength(2);
    expect(records.setAside()[0]).toMatchObject({
      status: 409,
      code: "request.invalid",
      event: { eventType: "assistant-message" },
    });
    expect(seen.length).toBeGreaterThan(2);
  });

  it("retries a refused batch one event at a time, so only the culprit is set aside", async () => {
    const { fixture, records } = fixtureWithLog();
    await fixture.controller.start("Project One");
    const seen = refuse(fixture, "turn-ended");

    await fixture.controller.sendMessage("message:1", "Write notes.", new AbortController().signal);

    const batches = seen.map((request) => request.events.map((event) => event.eventType));
    expect(batches.some((types) => types.length > 1 && types.includes("turn-ended"))).toBe(true);
    expect(batches.at(-1)).toEqual(["turn-ended"]);
    expect(records.setAside()).toHaveLength(1);
    expect(records.setAside()[0]).toMatchObject({ event: { eventType: "turn-ended" } });
    const stored = [...fixture.server.events.values()].map((event) => event.eventType);
    expect(stored).toContain("assistant-message");
    expect(stored).not.toContain("turn-ended");
  });

  it.each([
    ["a server error", rejection(500, "server.error", true)],
    ["a refused run", rejection(409, "run.unavailable")],
    ["a retryable invalid request", rejection(409, "request.invalid", true)],
  ])("keeps %s in the outbox instead of setting events aside", async (_name, error) => {
    const { fixture, records } = fixtureWithLog();
    await fixture.controller.start("Project One");
    refuse(fixture, "student-message", error);

    await fixture.controller
      .sendMessage("message:1", "Write notes.", new AbortController().signal)
      .catch(() => undefined);

    expect(records.setAside()).toEqual([]);
    expect(
      fixture.state.state.run?.outbox.some((e) => e.value.eventType === "student-message"),
    ).toBe(true);
  });

  it.each([
    ["no failure log is configured", undefined],
    ["the failure log fails", () => Promise.reject(new Error("disk full"))],
  ])("keeps delivering when %s", async (_name, append) => {
    const fixture = createFixtureController(
      append === undefined
        ? {}
        : {
            diagnostics: {
              client: { version: "1.0.0", platform: "test" },
              log: { path: "x", append },
            },
          },
    );
    await fixture.controller.start("Project One");
    refuse(fixture, "assistant-message");

    await fixture.controller.sendMessage("message:1", "Write notes.", new AbortController().signal);

    expect(fixture.state.state.run?.outbox).toEqual([]);
  });
});
