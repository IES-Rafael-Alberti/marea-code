import { expect, it, vi } from "vitest";
import { LatestRequest } from "./latest-request.js";
import { UsageHealthRequestError } from "./usage-health-client.boundary.js";

it("settles only the latest request and hands it its own signal", async () => {
  const latest = new LatestRequest();
  const first = Promise.withResolvers<string>();
  const settle = vi.fn();
  const signals: AbortSignal[] = [];
  const older = latest.run((signal) => {
    signals.push(signal);
    return first.promise;
  }, settle);
  await latest.run((signal) => {
    signals.push(signal);
    return Promise.resolve("new");
  }, settle);
  first.resolve("old");
  await older;
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  expect(settle.mock.calls).toEqual([[{ ok: true, value: "new" }]]);
});

it("reports failures as safe states and suppresses them once cancelled", async () => {
  const latest = new LatestRequest();
  const settle = vi.fn();
  await latest.run(() => Promise.reject(new Error("private")), settle);
  expect(settle).toHaveBeenCalledExactlyOnceWith({ ok: false, status: "error" });
  const pending = Promise.withResolvers<never>();
  const run = latest.run(() => pending.promise, settle);
  latest.cancel();
  pending.reject(new UsageHealthRequestError(403));
  await run;
  expect(settle).toHaveBeenCalledOnce();
});

it("maps only 401 and 403 request errors to denied", async () => {
  const statuses: string[] = [];
  for (const error of [401, 403, 400, 404, 500].map(
    (status) => new UsageHealthRequestError(status),
  ))
    await new LatestRequest().run(
      () => Promise.reject(error),
      (outcome) => {
        if (!outcome.ok) statuses.push(outcome.status);
      },
    );
  await new LatestRequest().run(
    () => Promise.reject(Object.assign(new Error("x"), { status: 403 })),
    (outcome) => {
      if (!outcome.ok) statuses.push(outcome.status);
    },
  );
  expect(statuses).toEqual(["denied", "denied", "error", "error", "error", "error"]);
});
