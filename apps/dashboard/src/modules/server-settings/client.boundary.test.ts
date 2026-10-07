import { beforeEach, expect, it, vi } from "vitest";
import { present, setupInput } from "../../setup/setup.fixture.js";
let saveSettings: typeof import("./client.boundary.js").saveSettings;
let settingsRequest: typeof import("./client.boundary.js").settingsRequest;
beforeEach(async () => {
  vi.resetModules();
  ({ saveSettings, settingsRequest } = await import("./client.boundary.js"));
});
const validSave = {
  operation: "save",
  expectedRevision: 0,
  connections: {},
  route: null,
  education: {},
  useCommonRoute: false,
};
it("preserves complete model routes and provider descriptors when reading and saving", async () => {
  const route = setupInput().route;
  const budget = present(route.budget);
  const education = {
    map: {
      providerId: route.providerId,
      model: route.model,
      inputTokenCeiling: budget.inputTokenCeiling,
      budget: budget.tutoring,
    },
  };
  const projection = {
    administrator: true,
    initialized: true,
    revision: 1,
    useCommonRoute: true,
    legacyRoutes: [{ classId: "class:legacy", route }],
    route,
    education,
    providers: [
      {
        id: route.providerId,
        descriptor: null,
        configured: true,
        supportsModels: true,
        values: {},
        secrets: ["apiKey"],
      },
    ],
  };
  const fetch = vi.fn(() => Promise.resolve(Response.json(projection)));
  const signal = new AbortController().signal;
  expect(await settingsRequest(fetch, { operation: "read" }, signal)).toEqual(projection);
  const payload = { ...validSave, route, education, useCommonRoute: true };
  expect(await saveSettings(fetch, payload, signal)).toEqual({ ok: true, value: projection });
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/v1/dashboard/server-settings",
    expect.objectContaining({ body: JSON.stringify(payload), signal }),
  );
});
it("keeps revision conflicts distinct from uncertain failures without replaying a write", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 409 }));
  const payload = validSave;
  expect(await saveSettings(fetch, payload, new AbortController().signal)).toEqual({
    ok: false,
    reason: "conflict",
  });
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockRejectedValue(new Error("synthetic-network-failure"));
  expect(await saveSettings(fetch, payload, new AbortController().signal)).toEqual({
    ok: false,
    reason: "unavailable",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("validates access responses and rejects a malformed public projection", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ administrator: false, initialized: false })));
  expect(await settingsRequest(fetch, { operation: "read" }, new AbortController().signal)).toEqual(
    { administrator: false, initialized: false },
  );
  fetch.mockResolvedValue(new Response(JSON.stringify({ administrator: true, providers: [] })));
  await expect(
    settingsRequest(fetch, { operation: "read" }, new AbortController().signal),
  ).rejects.toThrow();
});

it("accepts optional runtime addresses from the server without making them editable settings", async () => {
  const projection = {
    administrator: true,
    initialized: true,
    revision: 0,
    useCommonRoute: false,
    legacyRoutes: [],
    route: null,
    education: {},
    providers: [],
    connectionOrigins: ["http://10.0.4.25:18787"],
  };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(projection)));
  const signal = new AbortController().signal;
  expect(await settingsRequest(fetch, { operation: "read" }, signal)).toEqual(projection);
  expect(
    await saveSettings(
      fetch,
      { ...validSave, connectionOrigins: projection.connectionOrigins },
      signal,
    ),
  ).toEqual({ ok: false, reason: "invalid" });
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValue(new Response(JSON.stringify({ ...projection, connectionOrigins: [3] })));
  await expect(settingsRequest(fetch, { operation: "read" }, signal)).rejects.toThrow();
});
it("releases unread error bodies and bounds responses and payloads before any request", async () => {
  const signal = new AbortController().signal;
  const failingBody = new ReadableStream({
    cancel() {
      throw new Error("synthetic-cancel-failure");
    },
  });
  const fetch = vi.fn().mockResolvedValue(new Response(failingBody, { status: 400 }));
  expect(await saveSettings(fetch, { operation: "save" }, signal)).toEqual({
    ok: false,
    reason: "invalid",
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(settingsRequest(fetch, { operation: "read" }, signal)).rejects.toThrow("invalid");
  fetch.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(settingsRequest(fetch, { operation: "read" }, signal)).rejects.toThrow(
    "unavailable",
  );
  fetch.mockResolvedValue(new Response("x".repeat(262145)));
  await expect(settingsRequest(fetch, { operation: "read" }, signal)).rejects.toThrow(
    "unavailable",
  );
  fetch.mockRejectedValue("synthetic-non-error");
  expect(await saveSettings(fetch, validSave, signal)).toEqual({
    ok: false,
    reason: "unavailable",
  });
});
it("posts JSON to the settings endpoint, accepts the exact size limit and maps refused saves", async () => {
  const signal = new AbortController().signal;
  const body = JSON.stringify({ administrator: false, initialized: true });
  const fetch = vi.fn().mockResolvedValue(new Response(body.padEnd(262144, " ")));
  expect(await settingsRequest(fetch, { operation: "read" }, signal)).toEqual({
    administrator: false,
    initialized: true,
  });
  expect(fetch).toHaveBeenCalledWith("/api/v1/dashboard/server-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"operation":"read"}',
    signal,
  });
  fetch.mockResolvedValue(new Response("{}", { status: 400 }));
  expect(await saveSettings(fetch, validSave, signal)).toEqual({ ok: false, reason: "invalid" });
});
