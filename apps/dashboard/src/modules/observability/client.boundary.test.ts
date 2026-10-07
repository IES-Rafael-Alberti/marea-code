import { expect, it, vi } from "vitest";
import { observabilityRequest, ObservabilityResponse } from "./client.boundary.js";
it("posts authenticated, uncached settings operations and preserves safe status failures", async () => {
  const signal = new AbortController().signal;
  const fetch = vi.fn().mockResolvedValue(new Response('{"accepted":true}'));
  expect(await (await observabilityRequest(fetch, { operation: "test" }, signal)).json()).toEqual({
    accepted: true,
  });
  expect(fetch).toHaveBeenCalledWith("/api/v1/dashboard/observability", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: '{"operation":"test"}',
  });
  fetch.mockResolvedValue(new Response("private", { status: 403 }));
  await expect(observabilityRequest(fetch, {}, signal)).rejects.toMatchObject({ status: 403 });
  expect(ObservabilityResponse.safeParse({ privateKey: "never" }).success).toBe(false);
});
