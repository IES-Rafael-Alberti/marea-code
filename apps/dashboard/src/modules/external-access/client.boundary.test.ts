import { ExternalAccessRequestSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { ExternalAccessError, externalAccess, externalAccessRequest } from "./client.boundary.js";

const query = ExternalAccessRequestSchema.parse({
  kind: "external-access-query",
  protocolVersion: "0.1",
  requestId: "r:1",
  classId: "class:a",
});
const answer = {
  kind: "external-access",
  protocolVersion: "0.1",
  requestId: "r:1",
  classId: "class:a",
  providers: [],
  rules: [],
  rejected: [],
};
const json = (value: object, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("external access client", () => {
  it("posts the validated request with dashboard credentials and parses the answer", async () => {
    const fetchRequest = vi.fn(() => Promise.resolve(json(answer)));
    const signal = new AbortController().signal;
    await expect(externalAccessRequest(fetchRequest, query, signal)).resolves.toEqual(answer);
    expect(fetchRequest).toHaveBeenCalledWith("/api/v1/dashboard/external-access", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });
  });

  it.each([
    [json({ error: true }, 409), 409],
    [new Response(null, { status: 200 }), 0],
    [json({ ...answer, requestId: "r:other" }), 0],
    [json({ ...answer, classId: "class:other" }), 0],
  ])("refuses an unusable answer", async (response, status) => {
    await expect(
      externalAccessRequest(() => Promise.resolve(response), query, new AbortController().signal),
    ).rejects.toEqual(new ExternalAccessError(status));
  });

  it("rejects malformed and oversized answers and invalid requests", async () => {
    await expect(
      externalAccessRequest(
        () => Promise.resolve(json({ ...answer, extra: true })),
        query,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      externalAccessRequest(
        () => Promise.resolve(new Response("x".repeat(262_145))),
        query,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Dashboard response too large.");
    const fetchRequest = vi.fn();
    await expect(
      externalAccessRequest(fetchRequest, { ...query, classId: "" }, new AbortController().signal),
    ).rejects.toThrow();
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(new ExternalAccessError(404)).toMatchObject({
      status: 404,
      message: "External access is unavailable.",
    });
  });

  it("turns answers and failures into view outcomes", async () => {
    const signal = new AbortController().signal;
    await expect(
      externalAccess(() => Promise.resolve(json(answer)), query, signal),
    ).resolves.toEqual({ ok: true, value: answer });
    for (const [status, reason] of [
      [404, "missing"],
      [409, "conflict"],
      [500, "error"],
    ] as const)
      await expect(
        externalAccess(() => Promise.resolve(json({}, status)), query, signal),
      ).resolves.toEqual({ ok: false, reason });
    await expect(
      externalAccess(() => Promise.reject(new TypeError("offline")), query, signal),
    ).resolves.toEqual({ ok: false, reason: "error" });
  });
});
