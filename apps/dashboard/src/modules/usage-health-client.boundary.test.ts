import { expect, it, vi } from "vitest";
import {
  MAX_USAGE_HEALTH_RESPONSE_BYTES,
  TEACHER_HEALTH_PATH,
  USAGE_QUERY_PATH,
} from "@marea/protocol";
import { dashboardPost } from "../dashboard-post.js";
import {
  UsageHealthRequestError,
  createUsageHealthClient,
} from "./usage-health-client.boundary.js";
import { healthRequest, healthResult, usageQuery, usageResult } from "./usage-health.fixture.js";

const signal = new AbortController().signal;
const json = (value: object) => new Response(JSON.stringify(value));
const client = (response: Response | Promise<Response>) =>
  createUsageHealthClient(vi.fn().mockReturnValue(Promise.resolve(response)));

it("posts validated cookie requests to the exported paths and returns matching projections", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(usageResult))
    .mockResolvedValueOnce(json(healthResult));
  const port = createUsageHealthClient(fetch);
  expect(await port.queryUsage(usageQuery, signal)).toEqual(usageResult);
  expect(await port.readHealth(healthRequest, signal)).toEqual(healthResult);
  expect(fetch.mock.calls).toEqual([
    [USAGE_QUERY_PATH, dashboardPost(usageQuery, signal)],
    [TEACHER_HEALTH_PATH, dashboardPost(healthRequest, signal)],
  ]);
});

it("validates requests before any transport", async () => {
  const fetch = vi.fn();
  const port = createUsageHealthClient(fetch);
  await expect(
    port.queryUsage({ ...usageQuery, until: "2026-10-03T00:00:00.000Z" }, signal),
  ).rejects.toThrow();
  await expect(port.readHealth({ ...healthRequest, classId: "" }, signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([401, 403, 404, 503])(
  "keeps HTTP %s as a status and never reads the body",
  async (status) => {
    const response = new Response("/private/path diagnostic", { status });
    await expect(client(response).readHealth(healthRequest, signal)).rejects.toEqual(
      new UsageHealthRequestError(status),
    );
    expect(new UsageHealthRequestError(status).message).toBe("Class projection unavailable.");
    expect(response.bodyUsed).toBe(false);
  },
);

it("rejects missing, oversized, invalid and foreign projections", async () => {
  await expect(client(new Response(null)).queryUsage(usageQuery, signal)).rejects.toThrow(
    "Missing class projection.",
  );
  await expect(
    client(new Response(" ".repeat(MAX_USAGE_HEALTH_RESPONSE_BYTES + 1))).readHealth(
      healthRequest,
      signal,
    ),
  ).rejects.toThrow("too large");
  await expect(
    client(
      json({ ...healthResult, inference: { status: "available", observedAt: null } }),
    ).readHealth(healthRequest, signal),
  ).rejects.toMatchObject({ name: "ZodError" });
  for (const [foreign, read] of [
    [{ ...healthResult, requestId: "health:other" }, "health"],
    [{ ...healthResult, classId: "class:b" }, "health"],
    [{ ...usageResult, requestId: "usage:other" }, "usage"],
    [{ ...usageResult, classId: "class:b" }, "usage"],
    [{ ...usageResult, from: "2026-09-01T00:00:00.001Z" }, "usage"],
    [{ ...usageResult, until: "2026-09-07T00:00:00.000Z" }, "usage"],
  ] as const) {
    const port = client(json(foreign));
    await expect(
      read === "usage"
        ? port.queryUsage(usageQuery, signal)
        : port.readHealth(healthRequest, signal),
    ).rejects.toThrow("Class projection mismatch.");
  }
});

it("propagates transport failures, including cancellation", async () => {
  const aborted = new DOMException("aborted", "AbortError");
  await expect(
    createUsageHealthClient(vi.fn().mockRejectedValue(aborted)).queryUsage(usageQuery, signal),
  ).rejects.toBe(aborted);
});
