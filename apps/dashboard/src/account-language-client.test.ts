import { expect, it, vi } from "vitest";
import { createAccountLanguageClient } from "./account-language-client.boundary.js";
import { DashboardLanguageRequestSchema } from "@marea/protocol";
import type { DashboardFetch } from "./modules/active-runs/active-runs-client.boundary.js";
it("uses the authenticated bounded endpoint and validates acknowledgements", async () => {
  let mismatch = false;
  const fetch = vi.fn<DashboardFetch>((_path, init) => {
    const request = DashboardLanguageRequestSchema.parse(
      JSON.parse(typeof init.body === "string" ? init.body : ""),
    );
    return Promise.resolve(
      Response.json({
        protocolVersion: request.protocolVersion,
        requestId: mismatch ? "different" : request.requestId,
        preference: request.kind === "read" ? null : request.preference,
      }),
    );
  });
  const signal = new AbortController().signal,
    request = createAccountLanguageClient(fetch);
  expect(await request(null, signal)).toBeNull();
  expect(await request("eu", signal)).toBe("eu");
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/dashboard/profiles/language");
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  mismatch = true;
  await expect(request("es", signal)).rejects.toThrow("response mismatch");
  mismatch = false;
  fetch.mockImplementationOnce((_path, init) => {
    const body = DashboardLanguageRequestSchema.parse(
      JSON.parse(typeof init.body === "string" ? init.body : ""),
    );
    return Promise.resolve(
      Response.json({ protocolVersion: "0.1", requestId: body.requestId, preference: "en" }),
    );
  });
  await expect(request("es", signal)).rejects.toThrow("response mismatch");
  for (const body of ["error", null]) {
    const response = new Response(body, { status: 401 });
    const cancel = response.body === null ? null : vi.spyOn(response.body, "cancel");
    fetch.mockResolvedValueOnce(response);
    await expect(request(null, signal)).rejects.toThrow("Dashboard language unavailable.");
    if (cancel !== null) expect(cancel).toHaveBeenCalledOnce();
  }
  for (const response of [new Response("not-json"), new Response("x".repeat(4097))]) {
    fetch.mockResolvedValueOnce(response);
    await expect(request(null, signal)).rejects.toThrow();
  }
});
