import { describe, expect, it, vi } from "vitest";

import { createActiveRunsClient, type DashboardFetch } from "./active-runs-client.boundary.js";

const validBody = JSON.stringify({
  kind: "active-runs-response",
  protocolVersion: "0.1",
  requestId: "request:dashboard",
  generatedAt: "2026-09-03T08:00:00.000Z",
  viewer: { role: "teacher", displayName: "Ada" },
  runs: [],
  nextCursor: null,
});

describe("active runs dashboard client", () => {
  it("loads and validates an authenticated same-origin response", async () => {
    const fetchRequest = vi.fn<DashboardFetch>(() => Promise.resolve(new Response(validBody)));
    const signal = new AbortController().signal;
    const client = createActiveRunsClient(fetchRequest, () => "request:dashboard");

    await expect(client.load(signal)).resolves.toMatchObject({
      kind: "active-runs-response",
      requestId: "request:dashboard",
      runs: [],
    });
    expect(fetchRequest).toHaveBeenCalledWith(
      "/api/v1/dashboard/active-runs?kind=active-runs-query&protocolVersion=0.1&requestId=request%3Adashboard&limit=50",
      {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        method: "GET",
        signal,
      },
    );
  });

  it("rejects HTTP failures, invalid payloads, and invalid request identifiers", async () => {
    const failed = createActiveRunsClient(
      () => Promise.resolve(new Response(null, { status: 401 })),
      () => "request:dashboard",
    );
    const malformed = createActiveRunsClient(
      () => Promise.resolve(new Response("{}")),
      () => "request:dashboard",
    );
    const invalidId = createActiveRunsClient(
      () => Promise.resolve(new Response(validBody)),
      () => "invalid request id",
    );

    await expect(failed.load(new AbortController().signal)).rejects.toThrow(
      "The active runs request failed.",
    );
    await expect(malformed.load(new AbortController().signal)).rejects.toThrow();
    await expect(invalidId.load(new AbortController().signal)).rejects.toThrow();
  });

  it("creates browser request identifiers by default", async () => {
    const randomUUID = vi.fn(() => "00000000-0000-4000-8000-000000000000");
    vi.stubGlobal("crypto", { randomUUID });
    const fetchRequest = vi.fn<DashboardFetch>(() => Promise.resolve(new Response(validBody)));

    await createActiveRunsClient(fetchRequest).load(new AbortController().signal);

    expect(randomUUID).toHaveBeenCalledOnce();
    expect(fetchRequest.mock.calls[0]?.[0]).toContain(
      "request%3A00000000-0000-4000-8000-000000000000",
    );
  });
});
