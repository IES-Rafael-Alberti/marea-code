import { RunIdSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { StoredRun } from "./contracts.js";
import { setFixtureLeaseExpiry } from "./session-test.fixture.js";
import { createFixtureController } from "./student.fixture.js";

async function expiringFixture() {
  const fixture = createFixtureController();
  await fixture.controller.start("Project One");
  setFixtureLeaseExpiry(fixture.state);
  return fixture;
}

describe("StudentSessionController model run token", () => {
  it("single-flights concurrent lease renewal requests", async () => {
    const fixture = await expiringFixture();

    const [first, second] = await Promise.all([
      fixture.controller.modelRunToken(),
      fixture.controller.modelRunToken(),
    ]);

    expect(first).toBe(second);
    expect(fixture.server.renewCalls).toBe(1);
    expect(fixture.state.state.run?.leaseExpiresAt).toBe("2026-09-03T10:10:00.000Z");
  });

  it("refreshes rejected authentication before renewing", async () => {
    const fixture = await expiringFixture();
    fixture.server.rejectStored = true;

    await expect(fixture.controller.modelRunToken()).resolves.toBeDefined();

    expect(fixture.credentials.clears).toBe(1);
    expect(fixture.studentInterface.authenticationReasons).toEqual(["missing", "rejected"]);
    expect(fixture.server.renewCalls).toBe(1);
  });

  it("uses valid in-memory authentication after durable credentials are cleared", async () => {
    const fixture = await expiringFixture();
    await fixture.credentials.clear();
    fixture.studentInterface.authenticate = () =>
      Promise.reject(new Error("Interactive authentication must not run."));

    await expect(fixture.controller.modelRunToken()).resolves.toBeDefined();

    expect(fixture.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(fixture.credentials.clears).toBe(1);
    expect(fixture.server.bootstrapCalls).toBe(2);
    expect(fixture.server.renewCalls).toBe(1);
  });

  it("authenticates from scratch when recovery has no session credential", async () => {
    const original = await expiringFixture();
    const restarted = createFixtureController({ server: original.server, state: original.state });

    await expect(restarted.controller.modelRunToken()).resolves.toBeDefined();

    expect(restarted.studentInterface.authenticationReasons).toEqual(["missing"]);
    expect(original.server.renewCalls).toBe(1);
  });

  it("rejects a foreign renewal response without changing local state", async () => {
    const fixture = await expiringFixture();
    const renew = fixture.server.renewLease.bind(fixture.server);
    fixture.server.renewLease = async (token, request) => {
      const response = await renew(token, request);
      return {
        ...response,
        lease: { ...response.lease, runId: RunIdSchema.parse("run:foreign") },
      };
    };
    const before = structuredClone(fixture.state.state);
    const saves = fixture.state.saves;

    await expect(fixture.controller.modelRunToken()).rejects.toThrow("another run");

    expect(fixture.state.state).toEqual(before);
    expect(fixture.state.saves).toBe(saves);
  });

  it("rejects every invalid run transition during authentication", async () => {
    const changes: readonly ((run: StoredRun) => StoredRun | null)[] = [
      () => null,
      (run) => ({ ...run, phase: "opening" }),
      (run) => ({ ...run, runId: RunIdSchema.parse("run:replacement") }),
    ];
    for (const change of changes) {
      const fixture = await expiringFixture();
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const bootstrap = fixture.server.bootstrap.bind(fixture.server);
      fixture.server.bootstrap = async (token, request) => {
        entered.resolve(undefined);
        await release.promise;
        return bootstrap(token, request);
      };

      const renewal = fixture.controller.modelRunToken();
      await entered.promise;
      const run = fixture.state.state.run;
      if (run === null) throw new Error("Fixture run missing.");
      fixture.state.state = { ...fixture.state.state, run: change(run) };
      release.resolve(undefined);

      await expect(renewal).rejects.toThrow("changed while its lease was being renewed");
      expect(fixture.server.renewCalls).toBe(0);
    }
  });

  it("does not expose a token when either active-run identity field is missing", async () => {
    for (const missing of ["runId", "runToken"] as const) {
      const fixture = await expiringFixture();
      const run = fixture.state.state.run;
      if (run === null) throw new Error("Fixture run missing.");
      fixture.state.state = { ...fixture.state.state, run: { ...run, [missing]: null } };

      await expect(fixture.controller.modelRunToken()).rejects.toThrow(
        "No active run token is available",
      );
      expect(fixture.server.renewCalls).toBe(0);
    }
  });

  it("does not expose a token from a closed run", async () => {
    const fixture = await expiringFixture();
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    fixture.state.state = { ...fixture.state.state, run: { ...run, phase: "closed" } };

    await expect(fixture.controller.modelRunToken()).rejects.toThrow(
      "No active run token is available",
    );

    expect(fixture.server.renewCalls).toBe(0);
  });
});

it.each(["success", "cancelled", "exchange-failed"] as const)(
  "keeps authentication ownership and the same run (%s)",
  async (outcome) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    await fixture.controller.sendMessage(
      "message:before-login",
      "Start here.",
      new AbortController().signal,
    );
    setFixtureLeaseExpiry(fixture.state);
    const before = structuredClone(fixture.state.state.run);
    fixture.server.rejectStored = true;
    fixture.studentInterface.authKind = "login";
    if (outcome === "cancelled")
      vi.spyOn(fixture.studentInterface, "authenticate").mockRejectedValueOnce(
        new Error("Sign-in cancelled"),
      );
    let authenticating = false;
    const withAuthentication = vi.fn(async <T>(operation: () => Promise<T>) => {
      authenticating = true;
      try {
        return await operation();
      } finally {
        authenticating = false;
      }
    });
    const originalLogin = fixture.server.login.bind(fixture.server);
    vi.spyOn(fixture.server, "login").mockImplementation((request) => {
      expect(authenticating).toBe(true);
      return outcome === "exchange-failed"
        ? Promise.reject(new Error("Credential exchange failed"))
        : originalLogin(request);
    });
    Object.assign(fixture.studentInterface, { withAuthentication });
    const turn = fixture.controller.sendMessage(
      "message:after-login",
      "Continue here.",
      new AbortController().signal,
    );
    if (outcome === "success") await turn;
    else
      await expect(turn).rejects.toThrow(
        outcome === "cancelled" ? "Sign-in cancelled" : "Credential exchange failed",
      );
    expect(withAuthentication).toHaveBeenCalledOnce();
    expect(authenticating).toBe(false);
    expect(fixture.server.openRequests).toHaveLength(1);
    expect(fixture.state.state.run).toMatchObject({
      runId: before?.runId,
      snapshot: before?.snapshot,
      turns:
        outcome === "success"
          ? [
              ...(before?.turns ?? []),
              expect.objectContaining({ messageId: "message:after-login", state: "completed" }),
            ]
          : before?.turns,
    });
    expect(fixture.agent.messages).toBe(outcome === "success" ? 2 : 1);
  },
);
