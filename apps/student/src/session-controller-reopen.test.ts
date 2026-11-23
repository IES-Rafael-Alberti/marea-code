import { EventIdSchema, MessageIdSchema, RunIdSchema, SessionTokenSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { StoredRun } from "./contracts.js";
import { StudentHttpError } from "./http-error.js";
import { LocalSession } from "./local-session.js";
import { setFixtureLeaseExpiry } from "./session-test.fixture.js";
import { FIXTURE_CLOCK, FixtureIds, createFixtureController } from "./student.fixture.js";

type Fixture = ReturnType<typeof createFixtureController>;
type ReopenStoredRun = StoredRun & {
  readonly abandoned?: readonly ReopenStoredRun[];
};

function storedRun(fixture: Fixture): ReopenStoredRun {
  const run = fixture.state.state.run;
  if (run === null) throw new Error("Fixture run missing.");
  return run;
}

/** The server refuses to resume a run that belongs to another account or is already closed. */
function refuseResumeOf(fixture: Fixture, runId: string | null): void {
  const open = fixture.server.openRun.bind(fixture.server);
  fixture.server.openRun = (token, request) =>
    request.intent.kind === "resume" && request.runId === runId
      ? Promise.reject(new StudentHttpError(409, "run.unavailable", false))
      : open(token, request);
}

function restart(fixture: Fixture): Fixture {
  return createFixtureController({
    credentials: fixture.credentials,
    server: fixture.server,
    state: fixture.state,
  });
}

describe("StudentSessionController run reopen ownership", () => {
  it("falls back to the current account's run after rejecting a different stored run", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const foreignRunId = RunIdSchema.parse("run:foreign");
    fixture.state.state = {
      ...fixture.state.state,
      run: { ...storedRun(fixture), runId: foreignRunId },
    };
    refuseResumeOf(fixture, foreignRunId);
    await restart(fixture).controller.start("Project One");
    expect(fixture.server.openRequests.at(-1)).toMatchObject({
      intent: { kind: "resume" },
      runId: "run:1",
    });
    expect(storedRun(fixture).runId).toBe("run:1");
  });
  it("still resumes the local run when bootstrap points to another project", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const restarted = restart(fixture);

    await restarted.controller.start("Project One");

    expect(fixture.server.openRequests.at(-1)).toMatchObject({
      intent: { kind: "resume" },
      runId: "run:1",
    });
    expect(storedRun(fixture).abandoned ?? []).toEqual([]);
  });

  it("opens a new run once when the server refuses the local run", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    refuseResumeOf(fixture, storedRun(fixture).runId);
    fixture.server.active = false;
    const restarted = restart(fixture);

    await restarted.controller.start("Project One");

    // The refused resume never reaches the recording fixture; the fallback is the second open.
    expect(fixture.server.openRequests).toHaveLength(2);
    expect(fixture.server.openRequests[1]).toMatchObject({
      intent: { kind: "new" },
      project: { displayName: "Project One" },
    });
    expect(fixture.server.openRequests[1]).not.toHaveProperty("runId");
    expect(storedRun(fixture).phase).toBe("active");
    expect(storedRun(fixture).abandoned ?? []).toEqual([]);
  });

  it("sets aside undelivered events of a refused run without delivering them", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const originalRunId = storedRun(fixture).runId;
    await fixture.localSession.appendEvent("local:foreign", (sequence, occurredAt) => ({
      content: "Keep this undelivered event private",
      eventId: EventIdSchema.parse("event:foreign"),
      eventType: "student-message",
      messageId: MessageIdSchema.parse("message:foreign"),
      occurredAt,
      sequence,
    }));
    refuseResumeOf(fixture, originalRunId);
    fixture.server.active = false;
    const restarted = restart(fixture);

    await restarted.controller.start("Project One");

    const current = storedRun(fixture);
    expect(current.outbox).toEqual([]);
    expect(current.abandoned).toHaveLength(1);
    expect(current.abandoned?.[0]).toMatchObject({ runId: originalRunId });
    expect(current.abandoned?.[0]?.outbox).toHaveLength(1);
    expect(
      [...fixture.server.events.values()].some(
        (event) =>
          event.eventType === "student-message" &&
          event.content === "Keep this undelivered event private",
      ),
    ).toBe(false);
  });

  it("does not retry more than once when the fallback open is also refused", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    fixture.server.openRun = () =>
      Promise.reject(new StudentHttpError(409, "run.unavailable", false));
    const restarted = restart(fixture);

    await expect(restarted.controller.start("Project One")).rejects.toMatchObject({
      status: 409,
      code: "run.unavailable",
    });
  });

  it.each([
    { status: 409, code: "run.unavailable" },
    { status: 401, code: "auth.invalid" },
  ])("continues startup when a pending close is rejected with $code", async ({ status, code }) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    await local.beginClose("student-exit");
    fixture.server.closeRunAuthenticated = () =>
      Promise.reject(new StudentHttpError(status, code, false));
    fixture.server.active = false;
    fixture.server.rejectStored = true;
    const restarted = restart(fixture);

    await expect(restarted.controller.start("Project One")).resolves.toBeDefined();

    expect(restarted.studentInterface.authenticationReasons).toEqual(["rejected"]);
    expect(fixture.server.openRequests.at(-1)?.intent).toEqual({ kind: "new" });
    expect(storedRun(fixture).phase).toBe("active");
  });

  it("closes with the still-valid run lease instead of signing in again", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const runTokens: string[] = [];
    const close = fixture.server.closeRun.bind(fixture.server);
    fixture.server.closeRun = (token, request) => {
      runTokens.push(token);
      return close(token, request);
    };
    fixture.server.rejectStored = true;

    await fixture.controller.close();

    expect(runTokens).toHaveLength(1);
    expect(fixture.server.authenticatedCloseCalls).toBe(0);
    expect(fixture.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(fixture.state.state.run).toBeNull();
  });

  it.each(["2000-01-01T00:00:00.000Z", null])(
    "signs in again to close with rejected session and lease expiry %s",
    async (expiry) => {
      const fixture = createFixtureController();
      await fixture.controller.start("Project One");
      fixture.state.state = {
        ...fixture.state.state,
        run: { ...storedRun(fixture), leaseExpiresAt: expiry },
      };
      const renewedToken = SessionTokenSchema.parse("t".repeat(32));
      const enroll = fixture.server.enroll.bind(fixture.server);
      fixture.server.enroll = async (request) => {
        const response = await enroll(request);
        return { ...response, session: { ...response.session, token: renewedToken } };
      };
      const closeTokens: string[] = [];
      const close = fixture.server.closeRunAuthenticated.bind(fixture.server);
      fixture.server.closeRunAuthenticated = (token, request) => {
        closeTokens.push(token);
        return close(token, request);
      };
      // The original 30-minute session has expired: the server rejects it every time.
      const bootstrap = fixture.server.bootstrap.bind(fixture.server);
      fixture.server.bootstrap = (token, request) =>
        token === renewedToken
          ? bootstrap(token, request)
          : Promise.resolve({ authenticated: false as const });

      await fixture.controller.close();

      expect(closeTokens).toEqual([renewedToken]);
      expect(fixture.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
    },
  );
});

describe("StudentSessionController revoked lease recovery", () => {
  it("resumes once and retries a lease renewal rejected as unavailable", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    setFixtureLeaseExpiry(fixture.state);
    const bootstrap = vi.spyOn(fixture.server, "bootstrap");
    const renew = fixture.server.renewLease.bind(fixture.server);
    let attempts = 0;
    fixture.server.renewLease = (token, request) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new StudentHttpError(409, "run.unavailable", false));
      }
      return renew(token, request);
    };

    await expect(fixture.controller.modelRunToken()).resolves.toBeDefined();

    expect(attempts).toBe(2);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(fixture.server.openRequests).toHaveLength(2);
    expect(fixture.server.openRequests[1]).toMatchObject({
      intent: { kind: "resume" },
      runId: "run:1",
    });
    expect(storedRun(fixture).phase).toBe("active");
  });

  it("does not loop when the retry after lease recovery is also rejected", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    setFixtureLeaseExpiry(fixture.state);
    let attempts = 0;
    fixture.server.renewLease = () => {
      attempts += 1;
      return Promise.reject(new StudentHttpError(409, "run.unavailable", false));
    };

    await expect(fixture.controller.modelRunToken()).rejects.toMatchObject({
      status: 409,
      code: "run.unavailable",
    });

    expect(attempts).toBe(2);
    expect(fixture.server.openRequests).toHaveLength(2);
  });

  it("resumes once and retries an event append rejected as unavailable", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const append = fixture.server.appendRunEvents.bind(fixture.server);
    let attempts = 0;
    fixture.server.appendRunEvents = (token, request) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new StudentHttpError(409, "run.unavailable", false));
      }
      return append(token, request);
    };

    await fixture.controller.sendMessage(
      "message:revoked-lease",
      "Continue after reopening.",
      new AbortController().signal,
    );

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(fixture.server.openRequests).toHaveLength(2);
    expect(fixture.server.openRequests[1]?.intent).toEqual({ kind: "resume" });
    expect(fixture.agent.messages).toBe(1);
    expect(storedRun(fixture).turns.at(-1)).toMatchObject({
      messageId: "message:revoked-lease",
      state: "completed",
    });
  });
});
