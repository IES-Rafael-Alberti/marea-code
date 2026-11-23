import { expect, it, vi } from "vitest";
import { StudentHttpError } from "./http-error.js";
import { replaceFixtureRun } from "./session-test.fixture.js";
import { createFixtureController, FIXTURE_CLOCK, SESSION_TOKEN } from "./student.fixture.js";

it.each([
  [401, "server.error"],
  [403, "auth.invalid"],
  [503, "server.error"],
] as const)("preserves a pending close rejected with %s %s", async (status, code) => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  await fixture.localSession.beginClose("student-exit");
  const error = new StudentHttpError(status, code, false);
  vi.spyOn(fixture.server, "closeRunAuthenticated").mockRejectedValue(error);
  const restarted = createFixtureController(fixture);
  await expect(restarted.controller.start("Project")).rejects.toBe(error);
  expect(fixture.state.state.run?.phase).toBe("closing");
});

it.each(["run.unavailable", "auth.invalid"])(
  "propagates a live close rejection %s",
  async (code) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project");
    const error = new StudentHttpError(401, code, false);
    vi.spyOn(fixture.server, "closeRunAuthenticated").mockRejectedValue(error);
    await expect(fixture.controller.close()).rejects.toBe(error);
    expect(fixture.state.state.run?.phase).toBe("closing");
  },
);

it("reports stored-token bootstrap and pending opening recovery stages", async () => {
  const stages: string[] = [];
  const fixture = createFixtureController({ onStartupStage: (stage) => stages.push(stage) });
  fixture.credentials.token = SESSION_TOKEN;
  await fixture.localSession.ensureOpening("Project", { kind: "new" });
  await fixture.localSession.beginClose("student-exit");
  await fixture.controller.start("Project");
  expect(stages).toEqual([
    "capabilities",
    "authentication",
    "bootstrap",
    "run-open",
    "outbox",
    "bootstrap",
    "run-open",
    "outbox",
    "outbox",
  ]);
});

it("closes a stored run before startup using only its lease", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  const stages: string[] = [];
  const restarted = createFixtureController({
    ...fixture,
    onStartupStage: (stage) => stages.push(stage),
  });
  const bootstrap = vi.spyOn(fixture.server, "bootstrap");
  await restarted.controller.close();
  expect(stages).toEqual(["outbox"]);
  expect(bootstrap).not.toHaveBeenCalled();
  expect(fixture.server.authenticatedCloseCalls).toBe(0);
  expect(fixture.state.state.run).toBeNull();
});

it("does not close or resume a locally closed run", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  replaceFixtureRun(fixture.state, { phase: "closed" });
  const before = structuredClone(fixture.state.state);
  await fixture.controller.close();
  expect(fixture.state.state).toEqual(before);
  expect(fixture.server.authenticatedCloseCalls).toBe(0);
  fixture.server.active = false;
  await createFixtureController(fixture).controller.start("Project");
  expect(fixture.server.openRequests.at(-1)?.intent).toEqual({ kind: "new" });
});

it.each(["expired", "missing-token"])(
  "reauthenticates a rejected session with %s lease",
  async (scenario) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project");
    replaceFixtureRun(
      fixture.state,
      scenario === "expired" ? { leaseExpiresAt: FIXTURE_CLOCK.now() } : { runToken: null },
    );
    vi.spyOn(fixture.server, "bootstrap")
      .mockResolvedValueOnce({ authenticated: false })
      .mockResolvedValueOnce({ authenticated: false });
    await fixture.controller.close();
    expect(fixture.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
    expect(fixture.server.authenticatedCloseCalls).toBe(1);
  },
);

it("passes the complete already-closed response to local settlement", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  const closing = await fixture.localSession.beginClose("student-exit");
  const restarted = createFixtureController(fixture);
  const finish = vi.spyOn(restarted.localSession, "finishClose");
  vi.spyOn(fixture.server, "closeRunAuthenticated").mockRejectedValue(
    new StudentHttpError(401, "auth.invalid", false),
  );
  await restarted.controller.start("Project");
  expect(finish).toHaveBeenCalledExactlyOnceWith({
    protocolVersion: "0.1",
    requestId: closing.closeRequestId,
    runId: closing.runId,
    state: "closed",
    alreadyClosed: true,
  });
});
