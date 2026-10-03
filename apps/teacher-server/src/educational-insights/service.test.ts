import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./insights.fixture.js";
import { teacher, NOW } from "../../test-support/evaluation-fixture.js";

afterEach(() => {
  vi.useRealTimers();
});
it("dispatches authorized dashboard reads and report lifecycle actions", () => {
  const f = fixture();
  const read = (input: object) => f.service.read(teacher, f.query(input));
  expect(read({ kind: "settings" }).data).toMatchObject({
    mapConfigured: true,
    reportsConfigured: true,
  });
  expect(read({ kind: "map", viewerId: "viewer", visible: true }).data).toMatchObject({
    enabled: false,
  });
  expect(read({ kind: "progress", studentId: "s1" }).data).toMatchObject({ entries: [] });
  expect(read({ kind: "overview" }).data).toMatchObject({ next: null });
  expect(read({ kind: "reports" }).data).toMatchObject({ entries: [], configured: true });
  expect(read({ kind: "history", studentId: "s1", key: "missing", after: 0 }).data).toEqual({
    entries: [],
  });
  const generated = read({
    kind: "generate",
    from: "2026-01-01T00:00:00.000Z",
    to: NOW,
    locale: "en",
  });
  const id = (generated.data as { id: string }).id;
  expect(read({ kind: "report", reportId: id }).data).toMatchObject({ id, state: "queued" });
  expect(read({ kind: "cancel", reportId: id }).data).toMatchObject({ state: "cancelled" });
  expect(read({ kind: "retry", reportId: id }).data).toMatchObject({ state: "queued" });
  expect(() => read({ kind: "download", reportId: id })).toThrow("request.conflict");
  f.service.heartbeat("run:a");
  expect(f.service.map.presence.get("run:a")).toBe(Date.parse(NOW));
});
it("starts once, settles rejected ticks and waits for in-flight work on shutdown", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = Promise.withResolvers<undefined>();
  const map = vi.spyOn(f.service.map, "tick").mockReturnValue(pending.promise);
  const reports = vi.spyOn(f.service.reports, "tick").mockRejectedValue(new Error("offline"));
  const stopMap = vi.spyOn(f.service.map, "stop");
  const stopReports = vi.spyOn(f.service.reports, "stop");
  f.service.start();
  f.service.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(map).toHaveBeenCalledOnce();
  expect(reports).toHaveBeenCalledOnce();
  let stopped = false;
  const stopping = f.service.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);
  expect(stopMap).toHaveBeenCalledOnce();
  expect(stopReports).toHaveBeenCalledOnce();
  pending.resolve(undefined);
  await stopping;
  // Finished work leaves the in-flight set.
  expect(f.service.pending.size).toBe(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(map).toHaveBeenCalledOnce();
  f.service.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(map).toHaveBeenCalledTimes(2);
  await f.service.stop();
});
it("re-authorizes writes in their transaction and reports unconfigured analysis routes", () => {
  const f = fixture();
  const read = (input: object) => f.service.read(teacher, f.query(input));
  const require = vi.spyOn(f.service.progress, "require");
  read({
    kind: "configure",
    settings: { map: false, adaptive: true },
    expectedRevision: "initial",
  });
  expect(require).toHaveBeenCalledTimes(2);
  expect(() =>
    read({
      kind: "adjust",
      studentId: "s1",
      keys: ["missing"],
      level: 1,
      reason: "Reviewed",
      expectedRevision: f.progress.read("class:one", "s1").revision,
    }),
  ).toThrow("request.conflict");
  expect(require).toHaveBeenCalledTimes(4);
  expect(
    require.mock.calls.every(
      ([identity, classId]) => identity === teacher && classId === "class:one",
    ),
  ).toBe(true);
  f.service.configureRoutes({});
  expect(read({ kind: "settings" }).data).toMatchObject({
    mapConfigured: false,
    reportsConfigured: false,
  });
  expect(read({ kind: "reports" }).data).toMatchObject({ configured: false });
});
it("recovers unfinished inference at the current time before interrupting reports", () => {
  const f = fixture();
  const recover = vi.spyOn(f.service.inference.ledger, "recoverUnfinished");
  f.service.recover();
  expect(recover).toHaveBeenCalledExactlyOnceWith(NOW);
});
