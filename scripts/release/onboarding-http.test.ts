import { expect, it, vi } from "vitest";
import * as z from "zod";
import { onboardingHttp } from "./onboarding-http.boundary.js";
import { ServerSettingsError } from "../../apps/teacher-server/src/server-settings/contracts.js";
import { setupInput } from "./onboarding.fixture.js";
const origin = "http://127.0.0.1:12345";
function fixture() {
  const options = {
    origin: () => origin,
    token: "private-capability",
    assets: vi.fn(() => Promise.resolve(new Response("asset"))),
    read: vi.fn(() => ({ initialized: true })),
    models: vi.fn(() => Promise.resolve({ models: [] })),
    finish: vi.fn(() =>
      Promise.resolve({
        dashboardUrl: "http://127.0.0.1:18793/dashboard/",
        cookie: "session=private; HttpOnly",
      }),
    ),
  };
  return { ...options, handle: onboardingHttp(options) };
}
function request(
  body: unknown = { operation: "read" },
  init: RequestInit = {},
  url = `${origin}/setup/api`,
) {
  return new Request(url, {
    method: "POST",
    headers: {
      host: new URL(url).host,
      origin,
      authorization: "Bearer private-capability",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...init,
  });
}
it("requires exact Host, Origin, capability and a bounded closed-schema POST", async () => {
  const f = fixture();
  for (const headers of [
    { host: "evil.test", origin, authorization: "Bearer private-capability" },
    {
      host: "127.0.0.1:12345",
      origin: "https://evil.test",
      authorization: "Bearer private-capability",
    },
    { host: "127.0.0.1:12345", origin, authorization: "Bearer wrong" },
  ])
    expect((await f.handle(request({}, { headers }))).status).toBe(403);
  expect((await f.handle(request({}, {}, "http://127.0.0.1:9999/setup/api"))).status).toBe(403);
  expect((await f.handle(request(undefined, { method: "GET", body: null }))).status).toBe(405);
  expect((await f.handle(request({}, {}, `${origin}/setup/api?x=1`))).status).toBe(405);
  for (const body of [
    { operation: "erase" },
    { operation: "read", extra: true },
    { operation: "finish", setup: setupInput({ password: "short" }) },
    { operation: "models", providerId: "p", values: { key: "x".repeat(65537) } },
  ])
    expect((await f.handle(request(body))).status).toBe(400);
  expect(f.finish).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});
it("serves assets and returns settings/catalog without exposing completion cookies in JSON", async () => {
  const f = fixture();
  const asset = request({}, {}, `${origin}/dashboard/setup.html`);
  expect(await (await f.handle(asset)).text()).toBe("asset");
  expect(f.assets).toHaveBeenCalledWith(asset);
  expect(await (await f.handle(request())).json()).toEqual({ initialized: true });
  const query = { operation: "models", providerId: "p", values: { key: "synthetic" } };
  const models = request(query);
  expect(await (await f.handle(models)).json()).toEqual({ models: [] });
  expect(f.models).toHaveBeenCalledWith(query, models.signal);
  const input = setupInput();
  const finish = request({ operation: "finish", setup: input });
  const response = await f.handle(finish);
  expect(f.finish).toHaveBeenCalledWith(input, finish.signal);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("set-cookie")).toBe("session=private; HttpOnly");
  expect(await response.json()).toEqual({ dashboardUrl: "http://127.0.0.1:18793/dashboard/" });
  expect((await f.handle(request())).status).toBe(409);
});
it("serializes creation, permits retry after failure and does not leak errors", async () => {
  const f = fixture();
  const deferred = Promise.withResolvers<Awaited<ReturnType<typeof f.finish>>>();
  f.finish.mockReturnValueOnce(deferred.promise);
  const pending = f.handle(request({ operation: "finish", setup: setupInput() }));
  await vi.waitFor(() => {
    expect(f.finish).toHaveBeenCalledOnce();
  });
  expect((await f.handle(request())).status).toBe(409);
  deferred.reject(new Error("private-secret"));
  expect(await (await pending).json()).toEqual({ error: "unavailable" });
  f.finish.mockResolvedValueOnce({ dashboardUrl: "https://school.test/dashboard/" } as Awaited<
    ReturnType<typeof f.finish>
  >);
  const response = await f.handle(request({ operation: "finish", setup: setupInput() }));
  expect(response.status).toBe(200);
  expect(response.headers.has("set-cookie")).toBe(false);
});
it.each([
  [new z.ZodError([]), "invalid"],
  [new ServerSettingsError(400), "invalid"],
  [new ServerSettingsError(503), "unavailable"],
  ["private-secret", "unavailable"],
])("classifies setup errors without their raw details", async (error, code) => {
  const f = fixture();
  f.finish.mockRejectedValueOnce(error);
  expect(
    await (await f.handle(request({ operation: "finish", setup: setupInput() }))).json(),
  ).toEqual({ error: code });
});
it("an earlier read completing must not unlock a concurrent creation", async () => {
  const read = Promise.withResolvers<object>();
  const finish = Promise.withResolvers<{ dashboardUrl: string }>();
  const f = onboardingHttp({
    origin: () => origin,
    token: "private-capability",
    assets: () => Promise.resolve(new Response()),
    read: () => read.promise,
    models: () => Promise.resolve({}),
    finish: () => finish.promise,
  });
  const a = f(request());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const b = f(request({ operation: "finish", setup: setupInput() }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  read.resolve({});
  await a;
  expect((await f(request())).status).toBe(409);
  finish.resolve({ dashboardUrl: origin });
  await b;
});
it("returns stable safe error envelopes", async () => {
  const f = fixture();
  for (const [input, init, url, expected] of [
    [{}, { headers: {} }, undefined, "forbidden"],
    [{}, {}, `${origin}/setup/api?x`, "invalid"],
    [{ operation: "unknown" }, {}, undefined, "invalid"],
  ] as const)
    expect(await (await f.handle(request(input, init, url))).json()).toEqual({ error: expected });
  expect(await (await f.handle(request({}, {}, "http://127.0.0.1:9999/setup/api"))).json()).toEqual(
    { error: "forbidden" },
  );
  await f.handle(request({ operation: "finish", setup: setupInput() }));
  expect(await (await f.handle(request())).json()).toEqual({ error: "busy" });
});
it("returns a forbidden envelope for wrong capabilities on an otherwise valid origin", async () => {
  const response = await fixture().handle(
    request({}, { headers: { host: "127.0.0.1:12345", origin, authorization: "Bearer wrong" } }),
  );
  expect(await response.json()).toEqual({ error: "forbidden" });
});
