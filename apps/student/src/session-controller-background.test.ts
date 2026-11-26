import { TURN_DIAGNOSTICS_CAPABILITY } from "@marea/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FailureLog } from "./failure-log.boundary.js";
import { StudentHttpError } from "./http-error.js";
import { setFixtureLeaseExpiry } from "./session-test.fixture.js";
import { createFixtureController, FixtureServer } from "./student.fixture.js";

afterEach(() => {
  vi.useRealTimers();
});

const signInRequired = { code: "auth.invalid", status: 401 } as const;

async function expiringFixture(server = new FixtureServer()) {
  const records: Parameters<FailureLog["append"]>[0][] = [];
  const log: FailureLog = {
    path: "memory",
    append: (record) => {
      records.push(record);
      return Promise.resolve();
    },
  };
  const fixture = createFixtureController({
    diagnostics: { client: { platform: "test", version: "1.0.0" }, log },
    server,
  });
  await fixture.controller.start("Project One");
  setFixtureLeaseExpiry(fixture.state);
  return { ...fixture, records };
}

describe("StudentSessionController background lease checks", () => {
  it("never asks to sign in from the background, only once the student acts", async () => {
    const fixture = await expiringFixture();
    fixture.server.rejectStored = true;

    await expect(fixture.controller.modelRunToken(false)).rejects.toMatchObject(signInRequired);
    expect(fixture.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(fixture.credentials.clears).toBe(0);
    expect(fixture.server.renewCalls).toBe(0);

    fixture.server.rejectStored = true;
    await expect(fixture.controller.modelRunToken()).resolves.toBeDefined();
    expect(fixture.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
    expect(fixture.server.renewCalls).toBe(1);
  });

  it("never asks to sign in from the background when no credential is stored", async () => {
    const original = await expiringFixture();
    const restarted = createFixtureController({ server: original.server, state: original.state });

    await expect(restarted.controller.modelRunToken(false)).rejects.toMatchObject(signInRequired);
    expect(restarted.studentInterface.authenticationReasons).toEqual([]);
  });

  it("lets a student who acts during a failing background check sign in", async () => {
    const fixture = await expiringFixture();
    fixture.server.rejectStored = true;

    const background = fixture.controller.modelRunToken(false);
    const acting = fixture.controller.modelRunToken();

    await expect(background).rejects.toMatchObject(signInRequired);
    await expect(acting).resolves.toBeDefined();
    expect(fixture.server.bootstrapCalls).toBe(3);
    expect(fixture.server.renewCalls).toBe(1);
  });

  it("shares a check the student started instead of repeating it", async () => {
    const fixture = await expiringFixture();
    const offline = new Error("offline");
    fixture.server.renewLease = () => Promise.reject(offline);

    const acting = fixture.controller.modelRunToken();
    const background = fixture.controller.modelRunToken(false);

    await expect(acting).rejects.toBe(offline);
    await expect(background).rejects.toBe(offline);
    expect(fixture.server.bootstrapCalls).toBe(2);
  });

  it("shares one background check between background callers", async () => {
    const fixture = await expiringFixture();
    fixture.server.rejectStored = true;

    const first = fixture.controller.modelRunToken(false);
    const second = fixture.controller.modelRunToken(false);

    await expect(first).rejects.toMatchObject(signInRequired);
    await expect(second).rejects.toMatchObject(signInRequired);
    expect(fixture.server.bootstrapCalls).toBe(2);
  });
});

describe("StudentSessionController presence diagnostics", () => {
  async function present() {
    vi.useFakeTimers();
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const server = Object.assign(new FixtureServer(), { heartbeat });
    server.extraCapabilities = [TURN_DIAGNOSTICS_CAPABILITY];
    const fixture = await expiringFixture(server);
    await vi.advanceTimersByTimeAsync(0);
    const diagnostics = () =>
      [...server.events.values()].filter((event) => event.eventType === "turn-diagnostic");
    const outbox = () =>
      (fixture.state.state.run?.outbox ?? []).filter(
        (event) => event.value.eventType === "turn-diagnostic",
      );
    return { ...fixture, diagnostics, heartbeat, outbox };
  }

  it("records failed heartbeats for the teacher, again after a heartbeat succeeds", async () => {
    const f = await present();
    const refused = new StudentHttpError(409, "run.unavailable", false);
    f.heartbeat.mockRejectedValueOnce(refused).mockResolvedValueOnce(undefined);
    f.heartbeat.mockRejectedValueOnce(refused);
    await vi.advanceTimersByTimeAsync(30_000 * 3);

    expect(f.records.map((record) => record.category)).toEqual([
      "presence/http.run.unavailable",
      "presence/http.run.unavailable",
    ]);
    expect(f.outbox()).toHaveLength(2);
    expect(f.studentInterface.authenticationReasons).toEqual(["missing"]);
  });

  it("records failed renewals without asking to sign in, again after a renewal succeeds", async () => {
    const f = await present();
    f.server.rejectStored = true;
    await vi.advanceTimersByTimeAsync(30_000);
    setFixtureLeaseExpiry(f.state);
    await vi.advanceTimersByTimeAsync(30_000);
    setFixtureLeaseExpiry(f.state);
    f.server.rejectStored = true;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(f.records.map((record) => record.category)).toEqual([
      "lease-renewal/http.auth.invalid",
      "lease-renewal/http.auth.invalid",
    ]);
    expect(f.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(f.heartbeat).toHaveBeenCalledTimes(2);
    expect(f.diagnostics()).toEqual([]);
  });
});
