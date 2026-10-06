/* eslint-disable require-yield */
import {
  ProtocolVersionSchema,
  RequestIdSchema,
  RunIdSchema,
  ServerCapabilitySchema,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { LocalSession } from "./local-session.js";
import { TurnAttemptFailed } from "./contracts.js";
import { captureRejection } from "./session-test.boundary.js";
import {
  FIXTURE_CLOCK,
  FixtureAgent,
  FixtureIds,
  createFixtureController,
} from "./student.fixture.js";

describe("StudentSessionController boundaries", () => {
  it("rejects incompatible servers and missing capabilities", async () => {
    const unrelated = createFixtureController();
    unrelated.server.capabilities = (request) =>
      Promise.resolve({
        requestId: RequestIdSchema.parse("request:unrelated"),
        serverVersion: "1.0.0",
        supportedProtocolVersions: request.supportedProtocolVersions,
        capabilities: [],
      });
    await expect(unrelated.controller.start("Project One")).rejects.toThrow(
      "unrelated capabilities response",
    );

    const incompatible = createFixtureController();
    incompatible.server.capabilities = (request) =>
      Promise.resolve({
        requestId: request.requestId,
        serverVersion: "1.0.0",
        supportedProtocolVersions: [ProtocolVersionSchema.parse("9.9")],
        capabilities: [],
      });
    await expect(incompatible.controller.start("Project One")).rejects.toThrow("does not support");

    const missing = createFixtureController();
    missing.server.capabilities = (request) =>
      Promise.resolve({
        requestId: request.requestId,
        serverVersion: "1.0.0",
        supportedProtocolVersions: [ProtocolVersionSchema.parse("0.1")],
        capabilities: [ServerCapabilitySchema.parse("marea.auth.student")],
      });
    await expect(missing.controller.start("Project One")).rejects.toThrow(
      "The teacher server is missing required capabilities: marea.class.bootstrap, marea.runs.events, marea.runs.lifecycle, marea.runs.exact-resume, marea.runs.authenticated-close, marea.runs.lease-renewal.",
    );
  });

  it("rejects teacher login and a rejected newly issued session", async () => {
    const teacher = createFixtureController();
    teacher.studentInterface.authKind = "login";
    const login = teacher.server.login.bind(teacher.server);
    teacher.server.login = async (request) => ({
      ...(await login(request)),
      principal: { role: "teacher", displayName: "Teacher One" },
    });
    await expect(teacher.controller.start("Project One")).rejects.toThrow("Only a student account");

    const rejected = createFixtureController();
    rejected.server.bootstrap = () => Promise.resolve({ authenticated: false });
    await expect(rejected.controller.start("Project One")).rejects.toThrow(
      "new student session was rejected",
    );
  });

  it("rejects messaging and closing without a complete active run", async () => {
    const empty = createFixtureController();
    await expect(
      empty.controller.sendMessage("message:1", "Hello", new AbortController().signal),
    ).rejects.toThrow("No active student run");
    await empty.controller.close();
    await expect(empty.controller.start("Project One")).rejects.toThrow("session is closing");

    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    for (const incomplete of [
      { ...run, leaseExpiresAt: null, runId: null },
      { ...run, leaseExpiresAt: null, runToken: null },
      { ...run, snapshot: null },
      { ...run, leaseExpiresAt: null, phase: "opening" as const },
      { ...run, phase: "closing" as const },
      { ...run, leaseExpiresAt: null, phase: "closed" as const },
    ]) {
      fixture.state.state = { ...fixture.state.state, run: incomplete };
      await expect(
        fixture.controller.sendMessage("message:missing", "Hello", new AbortController().signal),
      ).rejects.toThrow("No active student run");
    }
    expect(fixture.server.renewCalls).toBe(0);
    fixture.state.state = { ...fixture.state.state, run: { ...run, runToken: null } };
    await expect(fixture.controller.close()).resolves.toBeUndefined();
    expect(fixture.server.authenticatedCloseCalls).toBe(1);
  });

  it("recovers and closes an opening request whose response was lost", async () => {
    const fixture = createFixtureController();
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "new" });

    await expect(fixture.controller.close()).resolves.toBeUndefined();

    expect(fixture.server.openRequests).toHaveLength(1);
    expect(fixture.state.state.run?.phase).toBe("closed");
  });

  it("preserves an exact pending resume but never reuses a local run for another project", async () => {
    const pending = createFixtureController();
    const pendingLocal = new LocalSession(pending.state, new FixtureIds(), FIXTURE_CLOCK);
    await pendingLocal.ensureOpening("Project One", { kind: "resume" }, RunIdSchema.parse("run:1"));

    await pending.controller.start("Project One");

    expect(pending.server.openRequests[0]).toMatchObject({
      intent: { kind: "resume" },
      project: { displayName: "Project One" },
      runId: "run:1",
    });

    const active = createFixtureController();
    await active.controller.start("Project One");
    const restarted = createFixtureController({
      credentials: active.credentials,
      server: active.server,
      state: active.state,
    });

    await restarted.controller.start("Project Two");

    const differentProject = active.server.openRequests.at(-1);
    expect(differentProject).toMatchObject({
      intent: { kind: "new" },
      project: { displayName: "Project Two" },
    });
    expect(differentProject).not.toHaveProperty("runId");
  });

  it("rejects an ambiguous pending resume without replacing its durable state", async () => {
    const fixture = createFixtureController();
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "resume" });
    const before = structuredClone(fixture.state.state);
    const saves = fixture.state.saves;

    await expect(fixture.controller.start("Project One")).rejects.toThrow(
      "The pending run resume has no server identifier.",
    );

    expect(fixture.state.state).toEqual(before);
    expect(fixture.state.saves).toBe(saves);
    expect(fixture.server.openRequests).toEqual([]);
  });

  it("settles a persisted opening close before starting a replacement run", async () => {
    const fixture = createFixtureController();
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "new" });
    await local.beginClose("student-exit");

    await fixture.controller.start("Project One");

    expect(fixture.server.authenticatedCloseCalls).toBe(1);
    expect(fixture.server.bootstrapCalls).toBe(2);
    expect(fixture.server.openRequests).toHaveLength(2);
    expect(fixture.state.state.run?.phase).toBe("active");
  });

  it("handles rejected approvals and empty invalid streams", async () => {
    const rejected = createFixtureController();
    rejected.studentInterface.decision = "rejected";
    await rejected.controller.start("Project One");
    await rejected.controller.sendMessage(
      "message:reject",
      "Do not write.",
      new AbortController().signal,
    );
    expect(rejected.workspace.writes).toBe(0);
    expect(rejected.agent.approvalTurns[0]).toMatchObject({
      approvalId: "approval:1",
      decision: "rejected",
      effect: null,
      messageId: "message:reject",
    });

    const empty = createFixtureController();
    empty.agent.streamMessage = async function* () {
      await Promise.resolve();
    };
    await empty.controller.start("Project One");
    const rejection = await captureRejection(
      empty.controller.sendMessage("message:empty", "Hello", new AbortController().signal),
    );
    expect(rejection).toBeInstanceOf(TurnAttemptFailed);
    if (rejection instanceof TurnAttemptFailed) {
      expect(rejection.prefix).toBe("");
      expect(rejection.cause.message).toBe("The agent stream ended without a terminal event.");
    }
  });

  it("rejects incomplete and mismatched pending close state", async () => {
    for (const missing of ["closeReason", "closeRequestId"] as const) {
      const incomplete = createFixtureController();
      await incomplete.controller.start("Project One");
      const local = new LocalSession(incomplete.state, new FixtureIds(), FIXTURE_CLOCK);
      const run = await local.beginClose("student-exit");
      incomplete.state.state = {
        ...incomplete.state.state,
        run: { ...run, [missing]: null, phase: "closing" },
      };
      await expect(incomplete.controller.start("Project One")).rejects.toThrow("pending run close");
    }

    const opening = createFixtureController();
    const openingLocal = new LocalSession(opening.state, new FixtureIds(), FIXTURE_CLOCK);
    await openingLocal.ensureOpening("Project One", { kind: "new" });
    const openingClose = await openingLocal.beginClose("student-exit");
    opening.state.state = {
      ...opening.state.state,
      run: { ...openingClose, closeReason: null },
    };
    await expect(opening.controller.start("Project One")).rejects.toThrow("pending run close");
    expect(opening.server.openRequests).toEqual([]);

    const mismatched = createFixtureController();
    await mismatched.controller.start("Project One");
    mismatched.server.closeRunAuthenticated = (token, request) => {
      expect(token).toBeDefined();
      return Promise.resolve({
        protocolVersion: "0.1",
        requestId: request.requestId,
        runId: RunIdSchema.parse("run:other"),
        state: "closed",
        alreadyClosed: false,
      });
    };
    await expect(mismatched.controller.close()).rejects.toThrow("another run");
  });

  it("rejects lease-based close recovery when the persisted bearer is missing", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    fixture.state.state = { ...fixture.state.state, run: { ...run, runToken: null } };
    const restarted = createFixtureController({ server: fixture.server, state: fixture.state });

    await expect(restarted.controller.close()).rejects.toThrow("no run token");

    expect(fixture.server.closeCalls).toBe(0);
  });

  it("rejects opening recovery that never establishes a server run identifier", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    fixture.localSession.beginClose = () =>
      Promise.resolve({
        ...run,
        closeReason: "student-exit",
        closeRequestId: new FixtureIds().request(),
        phase: "closing",
        runId: null,
      });

    await expect(fixture.controller.close()).rejects.toThrow("no server identifier");

    expect(fixture.server.closeCalls).toBe(0);
  });

  it("preserves cancelled assistant text and the selected close reason", async () => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* (turn, signal) {
      this.messageTurns.push(turn);
      await Promise.resolve(signal.aborted);
      yield { type: "assistant-text-delta", text: "Partial" };
      yield { type: "assistant-text-delta", text: " text" };
      yield { type: "turn-cancelled" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");
    await fixture.controller.sendMessage("message:partial", "Try.", new AbortController().signal);
    await fixture.controller.close("cancelled");

    expect([...fixture.server.events.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "assistant-message", content: "Partial text" }),
        expect.objectContaining({ eventType: "run-closed", reason: "cancelled" }),
      ]),
    );
    expect(fixture.studentInterface.events).toEqual([
      {
        attemptId: "attempt:7",
        messageId: "message:partial",
        type: "assistant-text",
        text: "Partial",
      },
      {
        attemptId: "attempt:7",
        messageId: "message:partial",
        type: "assistant-text",
        text: " text",
      },
      { attemptId: "attempt:7", messageId: "message:partial", type: "turn-cancelled" },
    ]);
    expect(fixture.state.state.run?.eventKeys).not.toContain("run:closed");
  });
});

it.each(["0.1.0-preview.6", "9.0.0-preview.1"])(
  "opens a session with software version %s when protocol and baseline capabilities agree",
  async (serverVersion) => {
    const fixture = createFixtureController();
    const original = fixture.server.capabilities.bind(fixture.server);
    fixture.server.capabilities = async (request) => ({
      ...(await original(request)),
      serverVersion,
      supportedProtocolVersions: [ProtocolVersionSchema.parse("0.1")],
    });
    await expect(fixture.controller.start("Compatible project")).resolves.toBeDefined();
    await fixture.controller.close();
  },
);
