import { expect, it, vi } from "vitest";
import type { TeacherHealthResponse, UsageHealthPort } from "@marea/protocol";
import { UsageHealthRequestError } from "../usage-health-client.boundary.js";
import { healthResult } from "../usage-health.fixture.js";
import { HealthController } from "./health-controller.js";

function fixture(read: () => Promise<TeacherHealthResponse> = () => Promise.resolve(healthResult)) {
  const readHealth = vi.fn<UsageHealthPort["readHealth"]>(read);
  const changed = vi.fn();
  return { readHealth, changed, controller: new HealthController({ readHealth }, changed) };
}

it("reads class health only for a selected class and preserves the observations", async () => {
  const f = fixture();
  expect(f.controller.state).toEqual({ status: "empty" });
  await f.controller.start(null);
  await f.controller.refresh();
  expect(f.readHealth).not.toHaveBeenCalled();
  expect(f.changed).not.toHaveBeenCalled();
  const loaded = f.controller.start("class:a");
  expect(f.controller.state).toEqual({ status: "loading" });
  expect(f.changed).toHaveBeenCalledOnce();
  await loaded;
  expect(f.readHealth.mock.calls[0]?.[0]).toEqual({
    protocolVersion: "0.1",
    requestId: expect.stringMatching(/^health:[\da-f-]{36}$/) as string,
    kind: "teacher-health-read",
    classId: "class:a",
  });
  expect(f.controller.state).toEqual({ status: "ready", response: healthResult });
  expect(f.changed).toHaveBeenCalledTimes(2);
  await f.controller.refresh();
  expect(f.readHealth).toHaveBeenCalledTimes(2);
});

it.each([
  [new UsageHealthRequestError(401), "denied"],
  [new UsageHealthRequestError(403), "denied"],
  [new UsageHealthRequestError(503), "error"],
  [new TypeError("private"), "error"],
] as const)("maps %s to a safe state", async (error, status) => {
  const f = fixture(() => Promise.reject(error));
  await f.controller.start("class:a");
  expect(f.controller.state).toEqual({ status });
});

it("aborts replaced and disposed reads and drops late results", async () => {
  const late = Promise.withResolvers<TeacherHealthResponse>();
  const f = fixture();
  f.readHealth.mockReturnValueOnce(late.promise);
  const first = f.controller.start("class:a");
  await f.controller.refresh();
  expect(f.readHealth.mock.calls[0]?.[1].aborted).toBe(true);
  late.resolve({ ...healthResult, storage: { status: "unknown", observedAt: null } });
  await first;
  expect(f.controller.state).toEqual({ status: "ready", response: healthResult });
  const pending = Promise.withResolvers<TeacherHealthResponse>();
  const g = fixture(() => pending.promise);
  const read = g.controller.start("class:a");
  g.controller.dispose();
  pending.reject(new UsageHealthRequestError(403));
  await read;
  await g.controller.refresh();
  expect(g.controller.state).toEqual({ status: "loading" });
  expect(g.changed).toHaveBeenCalledOnce();
  expect(g.readHealth).toHaveBeenCalledOnce();
});
