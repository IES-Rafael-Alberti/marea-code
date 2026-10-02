import { expect, it, vi } from "vitest";
import { saveSettings, settingsRequest } from "./client.boundary.js";
const validSave = {
  operation: "save",
  expectedRevision: 0,
  connections: {},
  route: null,
  education: {},
  useCommonRoute: false,
};
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
