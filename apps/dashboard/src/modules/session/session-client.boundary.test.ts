import { describe, expect, it, vi } from "vitest";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { createDashboardSessionClient } from "./session-client.boundary.js";

const REQUEST_ID = "request:session-1";
const signal = new AbortController().signal;

function respond(status: number, body: object = {}) {
  return vi
    .fn<DashboardFetch>()
    .mockImplementation(() => Promise.resolve(Response.json(body, { status })));
}

function bodyOf(fetchRequest: ReturnType<typeof respond>, index = 0): object {
  const body = fetchRequest.mock.calls[index]?.[1].body;
  if (typeof body !== "string") throw new Error("Expected JSON request body.");
  return JSON.parse(body) as object;
}

const session = (requestId = REQUEST_ID) => ({
  kind: "dashboard-session",
  protocolVersion: "0.1",
  requestId,
  principal: { role: "teacher", displayName: "Ada" },
});

const client = (fetchRequest: ReturnType<typeof respond>) =>
  createDashboardSessionClient(fetchRequest, () => REQUEST_ID);

describe("dashboard session client", () => {
  it("queries the cookie session with a same-origin, uncached JSON request", async () => {
    const fetchRequest = respond(200, session());
    expect(await client(fetchRequest).current(signal)).toEqual({
      status: "signed-in",
      displayName: "Ada",
    });
    expect(fetchRequest).toHaveBeenCalledExactlyOnceWith("/api/v1/dashboard/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "dashboard-session-query",
        protocolVersion: "0.1",
        requestId: REQUEST_ID,
      }),
    });
    expect(bodyOf(fetchRequest)).toEqual({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "dashboard-session-query",
    });
  });

  it("treats a missing, expired or non-teacher session as signed out and fails otherwise", async () => {
    for (const status of [401, 403])
      expect(await client(respond(status)).current(signal)).toEqual({ status: "signed-out" });
    await expect(client(respond(500)).current(signal)).rejects.toEqual(
      new Error("The session service is unavailable."),
    );
    await expect(client(respond(200, session("request:other"))).current(signal)).rejects.toThrow(
      "The session response does not match its request.",
    );
    await expect(client(respond(200, { kind: "other" })).current(signal)).rejects.toThrow();
  });

  it("signs in with a normalized login and reports each refusal", async () => {
    const fetchRequest = respond(200, session());
    expect(await client(fetchRequest).signIn("  Profe ", "correct horse battery", signal)).toEqual({
      status: "signed-in",
      displayName: "Ada",
    });
    expect(fetchRequest.mock.calls[0]?.[0]).toBe("/api/v1/dashboard/session/login");
    expect(bodyOf(fetchRequest)).toEqual({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "credential-login",
      credentials: { login: "profe", password: "correct horse battery" },
    });
    for (const [status, result] of [
      [401, "invalid"],
      [400, "invalid"],
      [403, "not-teacher"],
    ] as const)
      expect(
        await client(respond(status)).signIn("profe", "correct horse battery", signal),
      ).toEqual({ status: result });
    await expect(
      client(respond(503)).signIn("profe", "correct horse battery", signal),
    ).rejects.toThrow("The session service is unavailable.");
  });

  it("never sends credentials the server could not accept", async () => {
    const fetchRequest = respond(200, session());
    for (const [login, password] of [
      ["profe", "short"],
      ["no spaces allowed", "correct horse battery"],
      ["", "correct horse battery"],
    ] as const)
      expect(await client(fetchRequest).signIn(login, password, signal)).toEqual({
        status: "invalid",
      });
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("signs out, accepting an already expired session", async () => {
    const done = respond(200, {
      kind: "credential-logged-out",
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      loggedOutAt: "2026-09-15T10:00:00.000Z",
      alreadyLoggedOut: false,
    });
    await expect(client(done).signOut(signal)).resolves.toBeUndefined();
    expect(done.mock.calls[0]?.[0]).toBe("/api/v1/dashboard/session/logout");
    expect(bodyOf(done)).toEqual({
      protocolVersion: "0.1",
      requestId: REQUEST_ID,
      kind: "credential-logout",
    });
    await expect(client(respond(401)).signOut(signal)).resolves.toBeUndefined();
    await expect(client(respond(500)).signOut(signal)).rejects.toThrow(
      "The session service is unavailable.",
    );
    await expect(client(respond(200, { kind: "other" })).signOut(signal)).rejects.toThrow();
  });

  it("creates browser request identifiers by default", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000000" });
    try {
      const fetchRequest = respond(200, session("request:00000000-0000-4000-8000-000000000000"));
      await createDashboardSessionClient(fetchRequest).current(signal);
      expect(bodyOf(fetchRequest)).toMatchObject({
        requestId: "request:00000000-0000-4000-8000-000000000000",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
