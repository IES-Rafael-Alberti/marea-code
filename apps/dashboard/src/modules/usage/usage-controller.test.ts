import { expect, it, vi } from "vitest";
import type { UsageHealthPort, UsageResponse } from "@marea/protocol";
import { UsageHealthRequestError } from "../usage-health-client.boundary.js";
import { usageResult } from "../usage-health.fixture.js";
import { USAGE_PAGE_SIZE, UsageController } from "./usage-controller.js";

const now = new Date(2026, 8, 7, 12);
const midnight = (date: number) => new Date(2026, 8, date).toISOString();
function fixture(responses: (UsageResponse | Error | Promise<UsageResponse>)[] = []) {
  const queryUsage = vi.fn<UsageHealthPort["queryUsage"]>((request) => {
    const next = responses.shift() ?? usageResult;
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(next).then((value) => ({ ...value, requestId: request.requestId }));
  });
  const changed = vi.fn();
  const controller = new UsageController({ queryUsage }, changed, now);
  const request = (call: number) => queryUsage.mock.calls[call]?.[0];
  const signal = (call: number) => queryUsage.mock.calls[call]?.[1];
  return { queryUsage, changed, controller, request, signal };
}

it("stays empty without a class and queries the default seven days for a class", async () => {
  const f = fixture();
  const range = { from: "2026-09-01", to: "2026-09-07" };
  expect(f.controller.state).toEqual({ status: "empty", range, draft: range, page: 1 });
  await f.controller.start(null);
  await f.controller.refresh();
  expect(f.queryUsage).not.toHaveBeenCalled();
  expect(f.changed).not.toHaveBeenCalled();
  const loaded = f.controller.start("class:a");
  expect(f.controller.state).toEqual({ status: "loading", range, draft: range, page: 1 });
  expect(f.changed).toHaveBeenCalledOnce();
  await loaded;
  expect(f.request(0)).toEqual({
    protocolVersion: "0.1",
    requestId: expect.stringMatching(/^usage:[\da-f-]{36}$/) as string,
    kind: "class-usage-query",
    classId: "class:a",
    from: midnight(1),
    until: midnight(8),
    limit: USAGE_PAGE_SIZE,
  });
  expect(USAGE_PAGE_SIZE).toBe(25);
  expect(f.controller.state).toMatchObject({ status: "ready", page: 1, range });
  expect(f.changed).toHaveBeenCalledTimes(2);
});

it("pages forward by cursor, back to the retained cursor, and resets on a new period", async () => {
  const second = { ...usageResult, nextAfterAttemptId: "attempt:9" };
  const last = { ...usageResult, nextAfterAttemptId: null };
  const f = fixture([usageResult, second, last, second, usageResult]);
  await f.controller.start("class:a");
  await f.controller.next();
  expect(f.request(1)?.afterAttemptId).toBe("attempt:2");
  expect(f.controller.state.page).toBe(2);
  await f.controller.next();
  expect(f.request(2)?.afterAttemptId).toBe("attempt:9");
  expect(f.controller.state.page).toBe(3);
  await f.controller.next();
  expect(f.queryUsage).toHaveBeenCalledTimes(3);
  await f.controller.previous();
  expect(f.request(3)?.afterAttemptId).toBe("attempt:2");
  await f.controller.previous();
  expect(f.request(4)).not.toHaveProperty("afterAttemptId");
  expect(f.controller.state.page).toBe(1);
  await f.controller.previous();
  expect(f.queryUsage).toHaveBeenCalledTimes(5);
  await f.controller.next();
  await f.controller.refresh();
  expect(f.request(6)?.afterAttemptId).toBe("attempt:2");
  const changes = f.changed.mock.calls.length;
  f.controller.edit("from", "2026-08-20");
  expect(f.changed).toHaveBeenCalledTimes(changes + 1);
  expect(f.controller.state).toMatchObject({
    draft: { from: "2026-08-20", to: "2026-09-07" },
    range: { from: "2026-09-01" },
    page: 2,
  });
  await f.controller.apply();
  expect(f.request(7)).toMatchObject({ from: new Date(2026, 7, 20).toISOString() });
  expect(f.request(7)).not.toHaveProperty("afterAttemptId");
  expect(f.controller.state).toMatchObject({ page: 1, range: { from: "2026-08-20" } });
});

it("never queries an invalid draft and keeps edits made while a page loads", async () => {
  const pending = Promise.withResolvers<UsageResponse>();
  const f = fixture([usageResult, pending.promise]);
  await f.controller.start("class:a");
  f.controller.edit("to", "2026-10-15");
  await f.controller.apply();
  expect(f.queryUsage).toHaveBeenCalledOnce();
  f.controller.edit("to", "2026-09-07");
  const loading = f.controller.refresh();
  expect(f.controller.state.status).toBe("loading");
  await f.controller.previous();
  expect(f.queryUsage).toHaveBeenCalledTimes(2);
  f.controller.edit("from", "2026-09-03");
  pending.resolve(usageResult);
  await loading;
  expect(f.controller.state).toMatchObject({
    status: "ready",
    draft: { from: "2026-09-03" },
    range: { from: "2026-09-01" },
  });
});

it.each([
  [new UsageHealthRequestError(401), "denied"],
  [new UsageHealthRequestError(403), "denied"],
  [new UsageHealthRequestError(500), "error"],
  [new Error("secret"), "error"],
] as const)("maps %s to a safe state without a next page", async (error, status) => {
  const f = fixture([error]);
  await f.controller.start("class:a");
  expect(f.controller.state).toEqual(expect.objectContaining({ status, page: 1 }));
  expect(f.controller.state).not.toHaveProperty("response");
  await f.controller.next();
  expect(f.queryUsage).toHaveBeenCalledOnce();
});

it("cancels replaced and disposed reads and ignores their late results", async () => {
  const stale = Promise.withResolvers<UsageResponse>();
  const f = fixture([stale.promise, { ...usageResult, pricing: "complete" }]);
  const first = f.controller.start("class:a");
  await f.controller.refresh();
  expect(f.signal(0)?.aborted).toBe(true);
  stale.resolve({ ...usageResult, pricing: "unavailable" });
  await first;
  expect(f.controller.state).toMatchObject({ status: "ready", response: { pricing: "complete" } });
  const late = Promise.withResolvers<UsageResponse>();
  const g = fixture([late.promise]);
  const pending = g.controller.start("class:a");
  g.controller.dispose();
  expect(g.signal(0)?.aborted).toBe(true);
  late.resolve(usageResult);
  await pending;
  g.controller.edit("from", "2026-09-02");
  await g.controller.refresh();
  expect(g.changed).toHaveBeenCalledOnce();
  expect(g.controller.state.status).toBe("loading");
  expect(g.queryUsage).toHaveBeenCalledOnce();
});

it("does not page back while a later page is still loading", async () => {
  const pending = Promise.withResolvers<UsageResponse>();
  const f = fixture([usageResult, pending.promise]);
  await f.controller.start("class:a");
  const loading = f.controller.next();
  expect(f.controller.state).toMatchObject({ status: "loading", page: 2 });
  await f.controller.previous();
  expect(f.queryUsage).toHaveBeenCalledTimes(2);
  expect(f.signal(1)?.aborted).toBe(false);
  pending.resolve(usageResult);
  await loading;
  expect(f.controller.state).toMatchObject({ status: "ready", page: 2 });
});

it("never queries when the clock cannot produce a valid default period", async () => {
  const queryUsage = vi.fn<UsageHealthPort["queryUsage"]>();
  const changed = vi.fn();
  const controller = new UsageController({ queryUsage }, changed, new Date(Number.NaN));
  await controller.start("class:a");
  await controller.refresh();
  expect(queryUsage).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(controller.state.status).toBe("empty");
});
