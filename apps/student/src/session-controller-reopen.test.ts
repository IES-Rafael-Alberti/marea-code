import { EventIdSchema, MessageIdSchema, SessionTokenSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { StoredRun } from "./contracts.js";
import { StudentHttpError } from "./http-error.js";
import { LocalSession } from "./local-session.js";
import { setFixtureLeaseExpiry } from "./session-test.fixture.js";
import { FIXTURE_CLOCK, FixtureIds, createFixtureController } from "./student.fixture.js";

type Fixture = ReturnType<typeof createFixtureController>;
type ReopenStoredRun = StoredRun & {
  readonly userId?: string;
  readonly classId?: string;
  readonly abandoned?: readonly ReopenStoredRun[];
};

function storedRun(fixture: Fixture): ReopenStoredRun {
  const run = fixture.state.state.run;
  if (run === null) throw new Error("Fixture run missing.");
  return run;
}

function usePrincipal(
  fixture: Fixture,
  initial = { userId: "user:one", classId: "class:one" },
): (replacement: { userId: string; classId: string }) => void {
  let current = initial;
  const bootstrap = fixture.server.bootstrap.bind(fixture.server);
  fixture.server.bootstrap = async (token, request) => {
    const result = await bootstrap(token, request);
    if (!result.authenticated || result.value.kind !== "class-bootstrapped") return result;
    return {
      authenticated: true,
      value: {
        ...result.value,
        principal: { ...result.value.principal, userId: current.userId },
        classroom: { ...result.value.classroom, classId: current.classId },
      },
    };
  };
  return (replacement) => {
    current = replacement;
  };
}

function restart(fixture: Fixture): Fixture {
  return createFixtureController({
    credentials: fixture.credentials,
    server: fixture.server,
    state: fixture.state,
  });
}

describe("StudentSessionController run reopen ownership", () => {
  it.each([
    { changed: "user", principal: { userId: "user:two", classId: "class:one" } },
    { changed: "class", principal: { userId: "user:one", classId: "class:two" } },
  ])(
    "does not resume a local run after the authenticated $changed changes",
    async ({ principal }) => {
      const fixture = createFixtureController();
      const changePrincipal = usePrincipal(fixture);
      await fixture.controller.start("Project One");
      changePrincipal(principal);
      fixture.server.active = false;
      const restarted = restart(fixture);

      await restarted.controller.start("Project One");

      expect(fixture.server.openRequests).toHaveLength(2);
      expect(fixture.server.openRequests[1]).toMatchObject({
        intent: { kind: "new" },
        project: { displayName: "Project One" },
      });
      expect(fixture.server.openRequests[1]).not.toHaveProperty("runId");
      expect(storedRun(fixture)).toMatchObject(principal);
      expect(storedRun(fixture).abandoned ?? []).toEqual([]);
    },
  );

  it("sets aside an unbound legacy run unless bootstrap confirms its identity", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    fixture.server.active = false;
    const restarted = restart(fixture);

    await restarted.controller.start("Project One");

    expect(fixture.server.openRequests).toHaveLength(2);
    expect(fixture.server.openRequests[1]).toMatchObject({
      intent: { kind: "new" },
      project: { displayName: "Project One" },
    });
    expect(fixture.server.openRequests[1]).not.toHaveProperty("runId");
    expect(storedRun(fixture).abandoned ?? []).toEqual([]);
  });

  it("sets aside undelivered events from a mismatched principal without delivering them", async () => {
    const fixture = createFixtureController();
    const changePrincipal = usePrincipal(fixture);
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
    changePrincipal({ userId: "user:two", classId: "class:one" });
    fixture.server.active = false;
    const restarted = restart(fixture);

    await restarted.controller.start("Project One");

    const current = storedRun(fixture);
    expect(current.userId).toBe("user:two");
    expect(current.outbox).toEqual([]);
    expect(current.abandoned).toHaveLength(1);
    expect(current.abandoned?.[0]).toMatchObject({
      runId: originalRunId,
      userId: "user:one",
      classId: "class:one",
    });
    expect(current.abandoned?.[0]?.outbox).toHaveLength(1);
    expect(
      [...fixture.server.events.values()].some(
        (event) =>
          event.eventType === "student-message" &&
          event.content === "Keep this undelivered event private",
      ),
    ).toBe(false);
  });

  it.each([
    { status: 409, code: "run.unavailable" },
    { status: 401, code: "auth.invalid" },
  ])("continues startup when a pending close is rejected with $code", async ({ status, code }) => {
    const fixture = createFixtureController();
    usePrincipal(fixture);
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

  it("renews expired authentication before an authenticated close", async () => {
    const fixture = createFixtureController();
    usePrincipal(fixture);
    await fixture.controller.start("Project One");
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
    fixture.server.rejectStored = true;

    await fixture.controller.close();

    expect(closeTokens).toEqual([renewedToken]);
    expect(fixture.credentials.token).toBe(renewedToken);
    expect(fixture.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
  });
});

describe("StudentSessionController revoked lease recovery", () => {
  it("resumes once and retries a lease renewal rejected as unavailable", async () => {
    const fixture = createFixtureController();
    usePrincipal(fixture);
    await fixture.controller.start("Project One");
    setFixtureLeaseExpiry(fixture.state);
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
    expect(fixture.server.openRequests).toHaveLength(2);
    expect(fixture.server.openRequests[1]).toMatchObject({
      intent: { kind: "resume" },
      runId: "run:1",
    });
    expect(storedRun(fixture).phase).toBe("active");
  });

  it("does not loop when the retry after lease recovery is also rejected", async () => {
    const fixture = createFixtureController();
    usePrincipal(fixture);
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
    usePrincipal(fixture);
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
