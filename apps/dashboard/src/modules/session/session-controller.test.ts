import { describe, expect, it, vi } from "vitest";

import type { DashboardSessionClient } from "./session-client.boundary.js";
import { SessionController, type SessionState } from "./session-controller.js";

function clientFixture() {
  return {
    current: vi.fn<DashboardSessionClient["current"]>(),
    signIn: vi.fn<DashboardSessionClient["signIn"]>(),
    signOut: vi.fn<DashboardSessionClient["signOut"]>(),
  };
}

function controller(client = clientFixture()) {
  const states: SessionState[] = [];
  const session = new SessionController(client, (state) => {
    states.push(state);
  });
  return { client, session, states };
}

const initial: SessionState = {
  status: "checking",
  displayName: null,
  login: "",
  password: "",
  problem: null,
};

describe("dashboard session controller", () => {
  it("starts checking and follows the server's answer", async () => {
    const signedIn = controller();
    expect(signedIn.session.state).toEqual(initial);
    signedIn.client.current.mockResolvedValue({ status: "signed-in", displayName: "Ada" });
    await signedIn.session.check();
    expect(signedIn.states).toEqual([{ ...initial, status: "signed-in", displayName: "Ada" }]);
    expect(signedIn.client.current.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);

    const signedOut = controller();
    signedOut.client.current.mockResolvedValue({ status: "signed-out" });
    await signedOut.session.check();
    expect(signedOut.session.state).toEqual({ ...initial, status: "signed-out" });

    const offline = controller();
    offline.client.current.mockRejectedValue(new Error("offline"));
    await offline.session.check();
    expect(offline.session.state).toEqual({
      ...initial,
      status: "signed-out",
      problem: "unavailable",
    });
  });

  it("signs in once with the typed credentials and forgets the password", async () => {
    const { client, session, states } = controller();
    await session.signIn();
    expect(client.signIn).not.toHaveBeenCalled();
    client.current.mockResolvedValue({ status: "signed-out" });
    await session.check();
    session.setLogin("profe");
    session.setPassword("correct horse battery");
    let finish: (value: { status: "signed-in"; displayName: string }) => void = () => undefined;
    client.signIn.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = session.signIn();
    expect(session.state).toMatchObject({ status: "signing-in", problem: null });
    await session.signIn();
    expect(client.signIn).toHaveBeenCalledOnce();
    expect(client.signIn.mock.calls[0]?.slice(0, 2)).toEqual(["profe", "correct horse battery"]);
    finish({ status: "signed-in", displayName: "Ada" });
    await pending;
    expect(session.state).toEqual({
      status: "signed-in",
      displayName: "Ada",
      login: "profe",
      password: "",
      problem: null,
    });
    expect(states.map((state) => state.status)).toEqual([
      "signed-out",
      "signed-out",
      "signed-out",
      "signing-in",
      "signed-in",
    ]);
  });

  it("reports refused and failed sign-ins without keeping the password", async () => {
    for (const [outcome, problem] of [
      [Promise.resolve({ status: "invalid" } as const), "invalid"],
      [Promise.resolve({ status: "not-teacher" } as const), "not-teacher"],
      [Promise.reject(new Error("offline")), "unavailable"],
    ] as const) {
      const { client, session } = controller();
      outcome.catch(() => undefined);
      client.current.mockResolvedValue({ status: "signed-out" });
      await session.check();
      session.setLogin("profe");
      session.setPassword("wrong password here");
      client.signIn.mockReturnValue(outcome);
      await session.signIn();
      expect(session.state).toEqual({
        status: "signed-out",
        displayName: null,
        login: "profe",
        password: "",
        problem,
      });
    }
  });

  it("signs out only a signed-in teacher and stays signed in when that fails", async () => {
    const { client, session } = controller();
    await session.signOut();
    expect(client.signOut).not.toHaveBeenCalled();
    client.current.mockResolvedValue({ status: "signed-in", displayName: "Ada" });
    await session.check();
    client.signOut.mockRejectedValueOnce(new Error("offline"));
    const failing = session.signOut();
    expect(session.state.status).toBe("signing-out");
    await failing;
    expect(session.state).toMatchObject({
      status: "signed-in",
      displayName: "Ada",
      problem: "unavailable",
    });
    client.signOut.mockResolvedValueOnce(undefined);
    await session.signOut();
    expect(session.state).toMatchObject({ status: "signed-out", displayName: null, problem: null });
    expect(client.signOut.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it("cancels its requests and ignores late answers once disposed", async () => {
    const { client, session, states } = controller();
    let answer: (value: { status: "signed-out" }) => void = () => undefined;
    client.current.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const checking = session.check();
    session.dispose();
    expect(client.current.mock.calls[0]?.[0].aborted).toBe(true);
    answer({ status: "signed-out" });
    await checking;
    session.setLogin("late");
    expect(states).toEqual([]);
    expect(session.state).toEqual(initial);
  });
});
