import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentEvent,
  AgentMessageTurn,
  AuthenticationReason,
} from "../../apps/student/src/contracts.js";
import { createFileEffectLedger } from "../../apps/student/src/effect-ledger.boundary.js";
import type { FailureLog } from "../../apps/student/src/failure-log.boundary.js";
import { createFileStudentStores } from "../../apps/student/src/filesystem.boundary.js";
import { LocalSession } from "../../apps/student/src/local-session.js";
import { createSystemIdSource } from "../../apps/student/src/platform.boundary.js";
import { StudentSessionController } from "../../apps/student/src/session-controller.js";
import type { SessionPresence } from "../../apps/student/src/session-presence.js";
import { createCrashSafeWorkspaceWriter } from "../../apps/student/src/workspace-writer.js";
import { openGuardedWorkspace } from "../../packages/workspace-backend/src/index.js";
import {
  ACCEPTANCE_CLIENT_VERSION,
  ACCEPTANCE_SESSION,
} from "../../test-support/acceptance/harness.js";
import {
  AcceptanceAgent,
  AcceptanceInterface,
  AcceptanceResources,
} from "../../test-support/acceptance/resources.js";

const PRESENCE_MS = 30_000;
const MINUTE = 60_000;
const resources = new AcceptanceResources();

afterEach(async () => {
  vi.useRealTimers();
  await resources.close();
});

/** Enrolls once, then signs in again with the same account whenever Marea asks. */
class ReturningStudent extends AcceptanceInterface {
  public override authenticate(reason: AuthenticationReason) {
    if (this.authenticationReasons.length === 0) return super.authenticate(reason);
    this.authenticationReasons.push(reason);
    const { login, password } = ACCEPTANCE_SESSION.ada;
    return Promise.resolve({ kind: "login" as const, login, password });
  }
}

/** Runs a hook inside the turn, while the tutor is still answering. */
class MidTurnAgent extends AcceptanceAgent {
  public duringTurn: () => void = () => undefined;

  public override async *streamMessage(
    turn: AgentMessageTurn,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.duringTurn();
    yield* super.streamMessage(turn, signal);
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 5_000 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(condition()).toBe(true);
}

/** A student terminal, on a computer whose clock may run behind the teacher server's. */
async function classroom(options: { readonly clientSkewMs?: number } = {}) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const value = await resources.harness();
  const location = await resources.project("marea-presence-");
  const skew = options.clientSkewMs ?? 0;
  const clientClock = {
    now: () => new Date(Date.parse(value.clock.now()) - skew).toISOString(),
  };
  const failures: Parameters<FailureLog["append"]>[0][] = [];
  const log: FailureLog = {
    path: "memory",
    append: (record) => {
      failures.push(record);
      return Promise.resolve();
    },
  };
  const studentInterface = new ReturningStudent();
  const agent = new MidTurnAgent();
  const stores = await createFileStudentStores(location);
  const workspace = await openGuardedWorkspace({ rootPath: location.projectRoot });
  const controller = new StudentSessionController({
    agent,
    clientVersion: ACCEPTANCE_CLIENT_VERSION,
    clock: clientClock,
    credentials: stores.credentials,
    diagnostics: { client: { platform: "test", version: ACCEPTANCE_CLIENT_VERSION }, log },
    ids: createSystemIdSource(),
    localSession: new LocalSession(stores.state, createSystemIdSource(), clientClock),
    server: value.studentServer,
    studentInterface,
    workspace: createCrashSafeWorkspaceWriter({
      ledger: createFileEffectLedger(location.stateDirectory),
      workspace,
    }),
  });
  // The heartbeat starts synchronously on each interval and clears this flag when it settles.
  const busy = () =>
    (Reflect.get(controller, "presence") as SessionPresence | undefined)?.busy === true;
  const opened = await controller.start("presence-lab");
  await until(() => !busy());
  let messages = 0;
  return {
    agent,
    failures,
    opened,
    studentInterface,
    value,
    /** One presence interval of the student's terminal, on both clocks. */
    async tick(): Promise<void> {
      value.clock.advance(PRESENCE_MS);
      vi.advanceTimersByTime(PRESENCE_MS);
      await until(() => !busy());
    },
    send(): Promise<void> {
      messages += 1;
      return controller.sendMessage(
        `message:presence:${String(messages)}`,
        "Is the wave faster in deep water?",
        new AbortController().signal,
      );
    },
    session() {
      return value.database.readOne(
        "SELECT issued_at, expires_at, revoked_at FROM marea_auth_sessions ORDER BY issued_at DESC LIMIT 1",
      );
    },
    runs() {
      return value.database.readAll("SELECT id, state FROM marea_runs");
    },
    expireSession(): void {
      value.database.execute("UPDATE marea_auth_sessions SET expires_at = ?1", [value.clock.now()]);
    },
  };
}

describe("a present student's session", () => {
  it("stays signed in for three hours of work on a computer whose clock runs behind", async () => {
    const lab = await classroom({ clientSkewMs: 3 * MINUTE });
    for (let tick = 1; tick <= 360; tick += 1) {
      await lab.tick();
      if (tick % 4 === 0) await lab.send();
    }

    expect(lab.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(lab.runs()).toEqual([{ id: lab.opened.runId, state: "active" }]);
    expect(lab.agent.messageCalls).toBe(90);
  }, 300_000);

  it("stays signed in for three hours of presence alone", async () => {
    const lab = await classroom();
    for (let tick = 1; tick <= 360; tick += 1) await lab.tick();

    expect(lab.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(lab.failures).toEqual([]);
  }, 300_000);

  it("asks to sign in again only when the student acts, and keeps the same run", async () => {
    const lab = await classroom();
    lab.expireSession();
    for (let tick = 1; tick <= 20; tick += 1) await lab.tick();

    // The background renewal found the session expired: recorded, never a sign-in prompt.
    expect(lab.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(lab.failures).toEqual([
      expect.objectContaining({
        category: "lease-renewal/http.auth.invalid",
        kind: "connection-failed",
        status: 401,
      }),
    ]);

    await lab.send();

    expect(lab.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
    expect(lab.studentInterface.assistantText()).toContain("I will help.");
    expect(lab.runs()).toEqual([{ id: lab.opened.runId, state: "active" }]);
    expect(
      lab.value.database.readAll(
        "SELECT json_extract(payload_json, '$.category') AS category FROM marea_run_events WHERE event_type = 'turn-diagnostic'",
      ),
    ).toEqual([{ category: "lease-renewal/http.auth.invalid" }]);
  }, 60_000);

  it("finishes a turn whose session expires midway in the same run", async () => {
    const lab = await classroom();
    lab.agent.duringTurn = () => {
      lab.expireSession();
      // The tutor takes long enough that the run lease must be renewed before delivery.
      lab.value.clock.advance(10 * MINUTE);
    };

    await lab.send();

    expect(lab.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
    expect(lab.runs()).toEqual([{ id: lab.opened.runId, state: "active" }]);
    expect(
      lab.value.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type IN ('student-message', 'assistant-message', 'turn-ended') ORDER BY sequence",
      ),
    ).toEqual([
      { event_type: "student-message" },
      { event_type: "assistant-message" },
      { event_type: "turn-ended" },
    ]);
  }, 60_000);

  it("never revives a revoked session", async () => {
    const lab = await classroom();
    await lab.tick();
    lab.value.database.execute("UPDATE marea_auth_sessions SET revoked_at = ?1", [
      lab.value.clock.now(),
    ]);
    const revoked = lab.session();
    for (let tick = 1; tick <= 20; tick += 1) await lab.tick();

    expect(lab.session()).toEqual(revoked);
    expect(lab.studentInterface.authenticationReasons).toEqual(["missing"]);
    await lab.send();
    expect(lab.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
  }, 60_000);

  it("never keeps a session past eight hours from sign-in", async () => {
    const lab = await classroom();
    const cap = new Date(Date.parse(lab.value.clock.now()) + 45 * MINUTE).toISOString();
    lab.value.database.execute("UPDATE marea_auth_sessions SET issued_at = ?1", [
      new Date(Date.parse(cap) - 8 * 60 * MINUTE).toISOString(),
    ]);
    for (let tick = 1; tick <= 100; tick += 1) await lab.tick();

    expect(lab.session()).toEqual(expect.objectContaining({ expires_at: cap }));
    expect(lab.studentInterface.authenticationReasons).toEqual(["missing"]);
    await lab.send();
    expect(lab.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
    expect(lab.runs()).toEqual([{ id: lab.opened.runId, state: "active" }]);
  }, 60_000);
});
