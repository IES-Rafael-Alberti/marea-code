import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { InsightsRequestSchema } from "@marea/protocol";
import { useInsightModel, type InsightViewProps } from "./model.js";
const hooks = vi.hoisted(() => ({
  values: [] as (object | string | number | boolean | null)[],
  index: 0,
  refs: [] as object[],
  refIndex: 0,
  effects: [] as (() => undefined | (() => void))[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(create: () => T) => create(),
  useState: <T extends object | string | number | boolean | null>(initial: T) => {
    const index = hooks.index++;
    const current = index in hooks.values ? (hooks.values[index] as T) : initial;
    hooks.values[index] = current;
    return [
      current,
      (value: T | ((previous: T) => T)) => {
        hooks.values[index] =
          typeof value === "function" ? (value as (p: T) => T)(hooks.values[index] as T) : value;
      },
    ];
  },
  useRef: (initial: object | string | number) => {
    const index = hooks.refIndex++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index];
  },
  useEffect: (effect: () => undefined | (() => void)) => {
    hooks.effects.push(effect);
  },
}));
const map = { enabled: true, configured: true, entries: [] };
const progress = { revision: "revision:one", entries: [] };
const report = {
  id: "report:one",
  state: "queued",
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-09-28T00:00:00.000Z",
  completed: 0,
  total: 1,
  result: null,
  students: [],
};
const requests: ReturnType<typeof InsightsRequestSchema.parse>[] = [];
const fetchRequest: InsightViewProps["fetchRequest"] = (_url, init) => {
  if (typeof init.body !== "string") throw new Error("body");
  const q = InsightsRequestSchema.parse(JSON.parse(init.body));
  requests.push(q);
  const data =
    q.kind === "map"
      ? map
      : q.kind === "reports"
        ? { configured: true, entries: [] }
        : q.kind === "progress"
          ? q.studentId === null
            ? { students: [{ id: "student", displayName: "Ana" }] }
            : progress
          : q.kind === "adjust"
            ? progress
            : report;
  return Promise.resolve(
    Response.json({ requestId: q.requestId, classId: q.classId, kind: q.kind, data }),
  );
};
function render(
  kind: InsightViewProps["kind"],
  overrides: Partial<Omit<InsightViewProps, "classId">> = {},
) {
  hooks.index = 0;
  hooks.refIndex = 0;
  hooks.effects = [];
  return useInsightModel({
    kind,
    classId: "class:one",
    locale: "es",
    fetchRequest,
    navigate: () => Promise.resolve(true),
    ...overrides,
  });
}
beforeEach(() => {
  hooks.values = [];
  hooks.refs = [];
  requests.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("loads the map only as visible and unregisters its viewer on disposal", async () => {
  let state = render("map", { visible: false });
  await state.load();
  expect(requests.at(-1)).toMatchObject({ kind: "map", visible: false });
  state = render("map");
  const cleanup = hooks.effects.map((effect) => effect());
  await vi.advanceTimersByTimeAsync(15000);
  expect(requests.at(-1)).toMatchObject({ visible: true });
  for (const dispose of cleanup) dispose?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(requests.at(-1)).toMatchObject({ visible: false });
  expect(state.abort.current.signal.aborted).toBe(true);
});
it("loads students, paginates and refreshes progress after a teacher adjustment", async () => {
  let state = render("progress");
  await state.load();
  state = render("progress");
  expect(state.students[0]?.displayName).toBe("Ana");
  state.setPage("student:previous");
  state = render("progress");
  await state.load();
  expect(requests.at(-1)).toMatchObject({ after: "student:previous" });
  state.setStudent("student");
  state = render("progress");
  await state.load();
  state = render("progress");
  expect(state.data).toEqual(progress);
  await state.action({
    kind: "adjust",
    studentId: "student",
    keys: ["criterion"],
    level: 2,
    reason: "Reviewed",
    expectedRevision: "revision:one",
  });
  expect(requests.at(-2)?.kind).toBe("adjust");
  expect(render("progress").busy).toBe(false);
});
it("selects the generated report and reads its persistent state", async () => {
  let state = render("reports");
  await state.load();
  expect(render("reports").data).toEqual({ configured: true, entries: [] });
  await state.action({ kind: "generate", from: report.from, to: report.to, locale: "es" });
  state = render("reports");
  expect(state.selectedReport).toBe(report.id);
  await state.load();
  expect(requests.at(-1)).toMatchObject({ kind: "report", reportId: report.id });
  expect(render("reports").report).toEqual(report);
});
it("rejects foreign responses and clears busy after failed mutations", async () => {
  const bad: InsightViewProps["fetchRequest"] = () =>
    Promise.resolve(
      Response.json({ requestId: "foreign", classId: "class:other", kind: "map", data: map }),
    );
  let state = render("map", { fetchRequest: bad });
  await state.load();
  state = render("map", { fetchRequest: bad });
  expect(state.error).toBe(true);
  await state.action({ kind: "cancel", reportId: report.id });
  state = render("map", { fetchRequest: bad });
  expect(state.busy).toBe(false);
  expect(state.error).toBe(true);
});
it("ignores a response after disposal", async () => {
  const pending = Promise.withResolvers<Response>();
  const state = render("map", { fetchRequest: () => pending.promise });
  const load = state.load();
  state.abort.current.abort();
  pending.resolve(Response.json({ requestId: "bad", classId: "bad", kind: "map", data: map }));
  await load;
  expect(render("map").error).toBe(false);
  expect(render("map").data).toBeNull();
});
it.each(["map", "progress", "reports"] as const)(
  "ignores stale successful %s responses and keeps newer errors",
  async (kind) => {
    const pending = Promise.withResolvers<Response>();
    let response = new Response();
    const delayed: InsightViewProps["fetchRequest"] = async (url, init) => {
      response = await fetchRequest(url, init);
      return pending.promise;
    };
    const state = render(kind, { fetchRequest: delayed });
    const first = state.load();
    await Promise.resolve();
    const newer = render(kind, { fetchRequest: () => Promise.reject(new Error("offline")) });
    await newer.load();
    pending.resolve(response);
    await first;
    expect(render(kind).error).toBe(true);
    expect(render(kind).data).toBeNull();
    expect(render(kind).students).toEqual([]);
  },
);
it.each([false, true])("ignores disposed mutations (failure: %s)", async (failure) => {
  const pending = Promise.withResolvers<Response>();
  let response = new Response();
  const state = render("reports", {
    fetchRequest: async (url, init) => {
      response = await fetchRequest(url, init);
      return pending.promise;
    },
  });
  const action = state.action({ kind: "cancel", reportId: report.id });
  await Promise.resolve();
  state.abort.current.abort();
  if (failure) pending.reject(new Error("cancelled"));
  else pending.resolve(response);
  await action;
  expect(render("reports").report).toBeNull();
  expect(render("reports").error).toBe(false);
});
it.each(["progress", "reports"] as const)(
  "ignores disposed selected %s responses",
  async (kind) => {
    let state = render(kind);
    state.setStudent("student");
    state.setSelectedReport(report.id);
    state = render(kind);
    state.abort.current.abort();
    await state.load();
    expect(render(kind).data).toBeNull();
    expect(render(kind).report).toBeNull();
  },
);
it("refreshes progress on visibility changes without polling and disposes the listener", async () => {
  render("progress");
  const dispose = hooks.effects.map((effect) => effect());
  await vi.advanceTimersByTimeAsync(15000);
  expect(requests).toHaveLength(1);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1);
  expect(requests).toHaveLength(2);
  for (const cleanup of dispose) cleanup?.();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(requests).toHaveLength(2);
});
it("handles a failed viewer removal without leaking a rejected promise", async () => {
  render("map", { fetchRequest: () => Promise.reject(new Error("offline")) });
  const dispose = hooks.effects.map((effect) => effect());
  for (const cleanup of dispose) cleanup?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(render("map").error).toBe(false);
});
it("rejects a response with the wrong operation", async () => {
  const state = render("map", {
    fetchRequest: async (url, init) => {
      const response = await fetchRequest(url, init);
      return Response.json({ ...(await response.json()), kind: "reports" });
    },
  });
  await state.load();
  expect(render("map").error).toBe(true);
});
