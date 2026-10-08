import { expect, it, vi } from "vitest";
import {
  identityRequest,
  IdentitySettingsResponse,
  IdentityStatusResponse,
} from "./identity-client.js";
const response = { revision: 2, restart: true, providers: [] };
it("uses the authenticated settings endpoint and validates both credential and readiness projections", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(response));
  const signal = new AbortController().signal;
  expect(
    await identityRequest(fetch, { operation: "identity-read" }, IdentitySettingsResponse, signal),
  ).toEqual(response);
  expect(fetch).toHaveBeenLastCalledWith("/api/v1/dashboard/server-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"operation":"identity-read"}',
    signal,
  });
  fetch.mockResolvedValueOnce(
    Response.json({
      providers: [{ id: "test", guides: [], kinds: [{ kind: "email", ready: false }] }],
    }),
  );
  expect(
    await identityRequest(fetch, { operation: "identity-status" }, IdentityStatusResponse, signal),
  ).toMatchObject({ providers: [{ kinds: [{ ready: false }] }] });
});
it("rejects oversized, malformed or refused responses without including their private content", async () => {
  for (const [value, expected] of [
    [new Response("private", { status: 409 }), "conflict"],
    [new Response("private", { status: 403 }), "unavailable"],
    [new Response(" ".repeat(262145)), "invalid-response"],
    [new Response("not-json"), undefined],
    [Response.json({ ...response, secret: "private" }), undefined],
  ] as const) {
    const fetch = vi.fn().mockResolvedValue(value);
    await expect(
      identityRequest(fetch, {}, IdentitySettingsResponse, new AbortController().signal),
    ).rejects.toThrow(expected);
  }
});

it("accepts the maximum bounded public projection", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(response).padEnd(262144, " ")));
  expect(
    await identityRequest(fetch, {}, IdentitySettingsResponse, new AbortController().signal),
  ).toEqual(response);
});
