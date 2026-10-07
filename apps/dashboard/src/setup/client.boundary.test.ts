import { expect, it, vi } from "vitest";
import type { DashboardFetch } from "../modules/active-runs/active-runs-client.boundary.js";
import { createSetupClient } from "./client.boundary.js";
import { setupInput, setupIdentity } from "./setup.fixture.js";
it("uses the setup capability for settings and validates completion redirects", async () => {
  const response = {
    administrator: true,
    initialized: true,
    revision: 0,
    providers: [],
    route: null,
    education: {},
    legacyRoutes: [],
    useCommonRoute: false,
  };
  const fetch = vi
    .fn<DashboardFetch>()
    .mockResolvedValueOnce(
      Response.json({ settings: response, identityProviders: [setupIdentity] }),
    )
    .mockResolvedValueOnce(Response.json({ dashboardUrl: "http://127.0.0.1:18793/dashboard/" }));
  const client = createSetupClient("private-token", fetch);
  const signal = new AbortController().signal;
  expect(await client.read(signal)).toEqual({
    settings: response,
    identityProviders: [setupIdentity],
  });
  expect(fetch).toHaveBeenCalledWith(
    "/setup/api",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer private-token" },
      body: JSON.stringify({ operation: "read" }),
      signal,
    }),
  );
  expect(await client.finish(setupInput())).toBe("http://127.0.0.1:18793/dashboard/");
  expect(JSON.parse(fetch.mock.lastCall?.[1].body as string)).toEqual({
    operation: "finish",
    setup: setupInput(),
  });
});
it("rejects bad input, non-success and oversized or unsafe redirects", async () => {
  const fetch = vi.fn<DashboardFetch>();
  const client = createSetupClient("token", fetch);
  await expect(client.finish(setupInput({ password: "short" }))).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  for (const response of [
    new Response(null, { status: 400 }),
    new Response(" ".repeat(4097)),
    new Response("invalid"),
    Response.json({ dashboardUrl: "javascript:alert(1)" }),
    Response.json({ dashboardUrl: "https://school.test", extra: true }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    await expect(client.finish(setupInput())).rejects.toThrow();
  }
});
it("rejects an error status even with a valid body, enforces its size and restricts URL protocols", async () => {
  const body = JSON.stringify({ dashboardUrl: "https://school.test/dashboard/" });
  const fetch = vi.fn<DashboardFetch>();
  const client = createSetupClient("token", fetch);
  fetch.mockResolvedValueOnce(new Response(body, { status: 503 }));
  await expect(client.finish(setupInput())).rejects.toThrow("setup-unavailable");
  fetch.mockResolvedValueOnce(new Response(body.padEnd(4097, " ")));
  await expect(client.finish(setupInput())).rejects.toThrow("invalid-setup-response");
  fetch.mockResolvedValueOnce(new Response(body.padEnd(4096, " ")));
  expect(await client.finish(setupInput())).toBe("https://school.test/dashboard/");
  expect(fetch).toHaveBeenLastCalledWith(
    "/setup/api",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
    }),
  );
  for (const protocol of ["xhttp", "httpsx"]) {
    fetch.mockResolvedValueOnce(
      Response.json({ dashboardUrl: `${protocol}://school.test/dashboard/` }),
    );
    await expect(client.finish(setupInput())).rejects.toThrow();
  }
});

it("bounds and validates the complete generic setup catalog", async () => {
  const fetch = vi.fn<DashboardFetch>();
  const client = createSetupClient("token", fetch);
  const body = JSON.stringify({
    settings: { administrator: false, initialized: false },
    identityProviders: [],
  });
  fetch.mockResolvedValueOnce(new Response(body, { status: 500 }));
  await expect(client.read(new AbortController().signal)).rejects.toThrow("setup-unavailable");
  fetch.mockResolvedValueOnce(new Response(body.padEnd(262145, " ")));
  await expect(client.read(new AbortController().signal)).rejects.toThrow("invalid-setup-response");
  for (const response of [
    new Response(body, { status: 500 }),
    new Response(body.padEnd(262145, " ")),
    Response.json({ settings: {}, identityProviders: [] }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    await expect(client.read(new AbortController().signal)).rejects.toThrow();
  }
  fetch.mockResolvedValueOnce(new Response(body.padEnd(262144, " ")));
  expect(await client.read(new AbortController().signal)).toEqual(JSON.parse(body));
});

it("routes model discovery through the same local capability", async () => {
  const response = Response.json({ models: [] });
  const fetch = vi.fn<DashboardFetch>().mockResolvedValue(response);
  const client = createSetupClient("models-token", fetch);
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "models", providerId: "org.example.provider", values: {} }),
  };
  expect(await client.fetch("/api/v1/dashboard/server-settings", init)).toBe(response);
  expect(fetch).toHaveBeenCalledWith("/setup/api", {
    ...init,
    headers: { ...init.headers, authorization: "Bearer models-token" },
  });
});
