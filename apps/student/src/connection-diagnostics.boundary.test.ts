import { describe, expect, it, vi } from "vitest";

import { ConnectionDiagnostics } from "./connection-diagnostics.boundary.js";
import type { FailureLog } from "./failure-log.boundary.js";
import { StudentHttpError } from "./http-error.js";
import { LocalSession } from "./local-session.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";

const START = Date.parse("2026-09-03T10:00:00.000Z");
const CLIENT = { platform: "test-platform", version: "1.0.0" };

async function fixture(options: { readonly report?: boolean; readonly failLog?: boolean } = {}) {
  let now = START;
  const clock = { now: () => new Date(now).toISOString() };
  const { controller, localSession, state } = createFixtureController();
  await controller.start("Project");
  const ids = new FixtureIds();
  const records: Parameters<FailureLog["append"]>[0][] = [];
  const log: FailureLog = {
    path: "memory",
    append: (record) => {
      if (options.failLog === true) return Promise.reject(new Error("disk full"));
      records.push(record);
      return Promise.resolve();
    },
  };
  const diagnostics = new ConnectionDiagnostics({
    clock,
    diagnostics: { client: CLIENT, log },
    ids,
    localSession,
    reportToServer: () => options.report ?? true,
  });
  const events = () =>
    (state.state.run?.outbox ?? [])
      .map((event) => event.value)
      .filter((event) => event.eventType === "turn-diagnostic");
  return {
    diagnostics,
    events,
    records,
    state,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

const conflict = () => new StudentHttpError(409, "run.unavailable", false);

describe("connection diagnostics", () => {
  it("records a failed check locally and for the teacher, with its code and time", async () => {
    const f = await fixture();
    await f.diagnostics.failed("presence", conflict());
    await f.diagnostics.failed("lease-renewal", new StudentHttpError(503, "server.busy", true));

    expect(f.records).toEqual([
      {
        category: "presence/http.run.unavailable",
        kind: "connection-failed",
        occurredAt: "2026-09-03T10:00:00.000Z",
        status: 409,
      },
      {
        category: "lease-renewal/http.server.busy",
        kind: "connection-failed",
        occurredAt: "2026-09-03T10:00:00.000Z",
        status: 503,
      },
    ]);
    expect(f.events()).toEqual([
      expect.objectContaining({
        category: "presence/http.run.unavailable",
        client: CLIENT,
        eventType: "turn-diagnostic",
        exception: {
          message: "The Marea teacher server rejected the request.",
          name: "StudentHttpError",
        },
        messageId: "marea:connection",
        occurredAt: "2026-09-03T10:00:00.000Z",
        retryable: false,
      }),
      expect.objectContaining({ category: "lease-renewal/http.server.busy", retryable: true }),
    ]);
    const [first] = f.events();
    expect(f.state.state.run?.outbox[0]?.key).toBe(
      `connection-diagnostic:${String(first?.eventId)}`,
    );
  });

  it("records a network failure as retryable without an HTTP status", async () => {
    const f = await fixture();
    await f.diagnostics.failed("presence", new TypeError("fetch failed"));

    expect(f.records).toEqual([
      {
        category: "presence/client.TypeError",
        kind: "connection-failed",
        occurredAt: "2026-09-03T10:00:00.000Z",
      },
    ]);
    expect(f.events()).toEqual([expect.objectContaining({ retryable: true })]);
  });

  it("records the same failure at most once every ten minutes until a check succeeds", async () => {
    const f = await fixture();
    await f.diagnostics.failed("presence", conflict());
    f.advance(10 * 60 * 1_000 - 1);
    await f.diagnostics.failed("presence", conflict());
    expect(f.records).toHaveLength(1);
    f.advance(1);
    await f.diagnostics.failed("presence", conflict());
    expect(f.records).toHaveLength(2);

    await f.diagnostics.failed("lease-renewal", conflict());
    f.diagnostics.succeeded("lease-renewal");
    await f.diagnostics.failed("presence", conflict());
    expect(f.records).toHaveLength(3);
    f.diagnostics.succeeded("presence");
    await f.diagnostics.failed("presence", conflict());
    await f.diagnostics.failed("lease-renewal", conflict());
    expect(f.records.map((record) => record.category)).toEqual([
      "presence/http.run.unavailable",
      "presence/http.run.unavailable",
      "lease-renewal/http.run.unavailable",
      "presence/http.run.unavailable",
      "lease-renewal/http.run.unavailable",
    ]);
    expect(f.events()).toHaveLength(5);
  });

  it("keeps failures local when the server does not store diagnostics", async () => {
    const f = await fixture({ report: false });
    await f.diagnostics.failed("presence", conflict());

    expect(f.records).toHaveLength(1);
    expect(f.events()).toEqual([]);
  });

  it("still reports to the teacher when the local log cannot be written", async () => {
    const f = await fixture({ failLog: true });
    await f.diagnostics.failed("presence", conflict());

    expect(f.events()).toHaveLength(1);
  });

  it("never fails when the run can keep no more events", async () => {
    const f = await fixture();
    f.state.state = { ...f.state.state, run: null };

    await expect(f.diagnostics.failed("presence", conflict())).resolves.toBeUndefined();
    expect(f.records).toHaveLength(1);
  });

  it("does nothing without diagnostics", async () => {
    const f = await fixture();
    const ids = new FixtureIds();
    const reportToServer = vi.fn(() => true);
    const silent = new ConnectionDiagnostics({
      clock: { now: () => "2026-09-03T10:00:00.000Z" },
      diagnostics: undefined,
      ids,
      localSession: new LocalSession(f.state, new FixtureIds(), { now: () => "x" }),
      reportToServer,
    });
    await silent.failed("presence", conflict());

    expect(f.events()).toEqual([]);
    expect(reportToServer).not.toHaveBeenCalled();
    expect(ids.count).toBe(0);
  });
});
