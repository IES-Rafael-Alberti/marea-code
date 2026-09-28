import type { SessionsClient } from "./sessions-client.boundary.js";
import { afterEach, expect, it, vi } from "vitest";
import { RunHistoryResponseSchema, ClassSessionsResponseSchema } from "@marea/protocol";
import {
  evaluationClientFixture,
  HISTORY,
  SESSIONS as LEGACY_SESSIONS,
  NOW,
} from "../evaluation/evaluation.fixture.js";
import { EvaluationRequestError } from "../evaluation/evaluation-client.boundary.js";
import { SessionsController, SESSION_POLL_MS } from "./sessions-controller.js";
import type { NoticeClient } from "./notice-client.boundary.js";
const SESSIONS = ClassSessionsResponseSchema.parse({
  ...LEGACY_SESSIONS,
  kind: "class-sessions-response",
  runs: LEGACY_SESSIONS.runs.map((run) => ({ ...run, classId: "class:one" })),
});
const notices: NoticeClient = { publish: vi.fn(), query: vi.fn() };
const owned: SessionsController[] = [];
afterEach(() => {
  for (const controller of owned.splice(0)) controller.dispose();
  vi.useRealTimers();
});
function setup() {
  const client = {
    ...evaluationClientFixture(),
    classes: vi.fn<SessionsClient["classes"]>().mockResolvedValue(SESSIONS),
  };
  const changed = vi.fn();
  const controller = new SessionsController(client, notices, changed);
  owned.push(controller);
  return { client, changed, controller };
}
function page(runId: string, after = 0, through = after + 1, more = false) {
  return RunHistoryResponseSchema.parse({
    ...HISTORY,
    runId,
    afterSequence: after,
    throughSequence: through,
    nextSequence: more ? after + 1 : null,
    events: [
      {
        eventType: "assistant-message",
        eventId: `event:${runId}:${String(after + 1)}`,
        sequence: after + 1,
        occurredAt: NOW,
        content: runId,
      },
    ],
  });
}
it("polls durable pages at a frozen boundary, then resumes fresh reads without duplicates", async () => {
  vi.useFakeTimers();
  const { client, controller } = setup();
  client.history
    .mockResolvedValueOnce(page("run:a", 0, 2, true))
    .mockResolvedValueOnce(page("run:a", 1, 2))
    .mockResolvedValueOnce(page("run:a", 2, 3));
  await controller.start();
  await controller.select("run:a");
  expect(controller.state.catchingUp).toBe(true);
  await vi.advanceTimersByTimeAsync(SESSION_POLL_MS);
  expect(client.history.mock.calls[1]?.slice(0, 3)).toEqual(["run:a", 1, 2]);
  await vi.advanceTimersByTimeAsync(SESSION_POLL_MS);
  expect(client.history.mock.calls[2]?.slice(0, 3)).toEqual(["run:a", 2, undefined]);
  expect(controller.state.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(controller.state.connection).toBe("current");
  expect(controller.state.updatedAt).toBe(Date.now());
  expect(controller.state.catchingUp).toBe(false);
});
it("discards late history after rapid selection and class changes", async () => {
  const { client, controller } = setup();
  const first = Promise.withResolvers<ReturnType<typeof page>>();
  client.history.mockReturnValueOnce(first.promise).mockResolvedValueOnce(page("run:b"));
  const selecting = controller.select("run:a");
  await controller.select("run:b");
  first.resolve(page("run:a"));
  await selecting;
  expect(controller.state.events[0]).toMatchObject({ content: "run:b" });
  expect(client.history.mock.calls[0]?.[3].aborted).toBe(true);
  await controller.chooseClass("class:two");
  expect(controller.state.runId).toBeNull();
  expect(controller.state.events).toEqual([]);
  expect(client.classes).toHaveBeenLastCalledWith(null, expect.any(AbortSignal), "class:two");
  await controller.chooseClass(null);
  expect(client.classes).toHaveBeenLastCalledWith(null, expect.any(AbortSignal), undefined);
});
it("preserves the historical list page during polling and explicitly returns to newest", async () => {
  const { client, controller } = setup();
  await controller.start();
  await controller.more();
  await controller.refresh();
  expect(client.classes.mock.calls.map((call) => call[0])).toEqual([null, "run:one", "run:one"]);
  await controller.newest();
  expect(client.classes.mock.lastCall?.[0]).toBeNull();
  client.classes.mockResolvedValue(
    ClassSessionsResponseSchema.parse({ ...SESSIONS, nextBeforeRunId: null }),
  );
  await controller.refresh();
  client.classes.mockClear();
  await controller.more();
  expect(client.classes).not.toHaveBeenCalled();
});
it("retains readable history across a network failure but removes it on denied access", async () => {
  const { client, controller } = setup();
  client.history.mockResolvedValueOnce(page("run:a"));
  await controller.select("run:a");
  client.history.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  expect(controller.state.events).toHaveLength(1);
  expect(controller.state.connection).toBe("stale");
  await controller.openEvaluation();
  expect(controller.review).toBeDefined();
  expect(controller.notice).toBeDefined();
  client.history.mockRejectedValueOnce(new EvaluationRequestError(403));
  await controller.refresh();
  expect(controller.state.events).toEqual([]);
  expect(controller.state.runId).toBeNull();
  expect(controller.review).toBeUndefined();
  expect(controller.notice).toBeUndefined();
});
it("keeps independent review and notice drafts when returning to a session", async () => {
  const { client, controller } = setup();
  client.history.mockImplementation((id) => Promise.resolve(page(id)));
  await controller.openEvaluation();
  expect(client.query).not.toHaveBeenCalled();
  await controller.select("run:one");
  await controller.openEvaluation();
  const review = controller.review;
  const notice = controller.notice;
  notice?.edit("Unsent draft");
  await controller.openEvaluation();
  expect(client.query).toHaveBeenCalledTimes(1);
  await controller.select("run:two");
  expect(controller.notice?.state.draft).toBe("");
  await controller.select("run:one");
  expect(controller.review).toBe(review);
  expect(controller.notice).toBe(notice);
  expect(controller.notice?.state.draft).toBe("Unsent draft");
  await controller.select(null);
  expect(controller.state.events).toEqual([]);
});
it("aborts on disposal and neither notifies nor schedules another poll after a late completion", async () => {
  vi.useFakeTimers();
  const { client, changed, controller } = setup();
  const response = Promise.withResolvers<typeof SESSIONS>();
  client.classes.mockReturnValue(response.promise);
  const started = controller.start();
  await controller.refresh();
  expect(client.classes).toHaveBeenCalledOnce();
  controller.dispose();
  changed.mockClear();
  response.resolve(SESSIONS);
  await started;
  await vi.advanceTimersByTimeAsync(10000);
  expect(changed).not.toHaveBeenCalled();
  expect(client.classes).toHaveBeenCalledOnce();
});
it("ignores an old class listing and reports read errors without an unhandled rejection", async () => {
  const { client, controller } = setup();
  const response = Promise.withResolvers<typeof SESSIONS>();
  client.classes.mockReturnValueOnce(response.promise).mockResolvedValueOnce(SESSIONS);
  const first = controller.chooseClass("class:old");
  await controller.chooseClass("class:new");
  response.resolve({ ...SESSIONS, runs: [] });
  await first;
  expect(controller.state.runs).toHaveLength(1);
  client.classes.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  expect(controller.state.connection).toBe("stale");
  expect(controller.state.moreBusy).toBe(false);
});
it("does not let a successful history read hide a failed list request, in either response order", async () => {
  const { controller, client } = setup();
  await controller.start();
  client.history.mockResolvedValue(page("run:a"));
  await controller.select("run:a");
  client.classes.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  expect(controller.state.connection).toBe("stale");
  await controller.refresh();
  expect(controller.state.connection).toBe("current");
  const listing = Promise.withResolvers<typeof SESSIONS>();
  client.classes.mockReturnValueOnce(listing.promise);
  client.history.mockRejectedValueOnce(new Error("offline"));
  const refresh = controller.refresh();
  await Promise.resolve();
  listing.resolve(SESSIONS);
  await refresh;
  expect(controller.state.connection).toBe("stale");
  await controller.select(null);
  expect(controller.state.connection).toBe("current");
  client.classes.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  await controller.select(null);
  expect(controller.state.connection).toBe("stale");
});
it.each([401, 403])(
  "clears cached private data on list denial %s and suppresses a late history read",
  async (status) => {
    const { controller, client } = setup();
    await controller.start();
    client.history.mockResolvedValueOnce(page("run:a"));
    await controller.select("run:a");
    await controller.openEvaluation();
    controller.notice?.edit("private draft");
    const response = Promise.withResolvers<ReturnType<typeof page>>();
    client.history.mockReturnValueOnce(response.promise);
    client.classes.mockRejectedValueOnce(new EvaluationRequestError(status));
    const refresh = controller.refresh();
    await Promise.resolve();
    response.resolve(page("run:a", 1));
    await refresh;
    expect(controller.state).toMatchObject({
      runs: [],
      events: [],
      runId: null,
      next: null,
      updatedAt: null,
      connection: "stale",
    });
    expect(controller.review).toBeUndefined();
    expect(controller.notice).toBeUndefined();
  },
);
it("does not overlap a selected history request or replace a pending older page with polling", async () => {
  const { controller, client } = setup();
  await controller.start();
  const history = Promise.withResolvers<ReturnType<typeof page>>();
  client.history.mockReturnValueOnce(history.promise);
  const selecting = controller.select("run:a");
  await controller.refresh();
  expect(controller.state.connection).toBe("loading");
  expect(client.history).toHaveBeenCalledOnce();
  history.resolve(page("run:a"));
  await selecting;
  const listing = Promise.withResolvers<typeof SESSIONS>();
  client.classes.mockReturnValueOnce(listing.promise);
  const more = controller.more();
  const calls = client.classes.mock.calls.length;
  await controller.more();
  client.history.mockResolvedValueOnce(page("run:a", 1));
  await controller.refresh();
  expect(client.classes).toHaveBeenCalledTimes(calls);
  listing.resolve(SESSIONS);
  await more;
  expect(controller.state.moreBusy).toBe(false);
});
it("ignores rejections from superseded list and history selections and notifications after disposal", async () => {
  const { controller, client, changed } = setup();
  const list = Promise.withResolvers<typeof SESSIONS>();
  client.classes.mockReturnValueOnce(list.promise);
  const loading = controller.chooseClass("class:old");
  await controller.chooseClass("class:new");
  list.reject(new Error("aborted"));
  await loading;
  expect(controller.state.connection).toBe("current");
  const history = Promise.withResolvers<ReturnType<typeof page>>();
  client.history.mockReturnValueOnce(history.promise);
  const selecting = controller.select("run:old");
  await controller.select(null);
  history.reject(new Error("aborted"));
  await selecting;
  expect(controller.state.connection).toBe("current");
  controller.dispose();
  changed.mockClear();
  await controller.select(null);
  expect(changed).not.toHaveBeenCalled();
});
it("clears class context immediately, cancels the previous selection and preserves its own loading state", async () => {
  const { controller, client } = setup();
  expect(controller.state).toEqual({
    classId: null,
    runs: [],
    next: null,
    runId: null,
    selected: null,
    events: [],
    connection: "loading",
    updatedAt: null,
    catchingUp: false,
    moreBusy: false,
  });
  await controller.start();
  client.history.mockResolvedValueOnce(page("run:one", 0, 2, true));
  await controller.select("run:one");
  const selectionSignal = client.history.mock.calls[0]?.[3];
  const list = Promise.withResolvers<typeof SESSIONS>();
  client.classes.mockReturnValueOnce(list.promise);
  const choosing = controller.chooseClass("class:two");
  expect(selectionSignal?.aborted).toBe(true);
  expect(controller.state).toMatchObject({
    classId: "class:two",
    runs: [],
    next: null,
    runId: null,
    selected: null,
    events: [],
    connection: "loading",
    updatedAt: null,
    catchingUp: false,
    moreBusy: false,
  });
  list.resolve(SESSIONS);
  await choosing;
  expect(controller.state.connection).toBe("current");
  client.history.mockResolvedValueOnce(page("run:new"));
  await controller.select("run:new");
  expect(client.history.mock.lastCall?.slice(0, 3)).toEqual(["run:new", 0, undefined]);
  expect(controller.state.catchingUp).toBe(false);
});
it("pins selected identity across paging and refreshes its metadata when the run is on the page", async () => {
  const { controller, client } = setup();
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const first = SESSIONS.runs[0];
  if (first === undefined) throw new Error("Missing session fixture");
  const other = ClassSessionsResponseSchema.parse({
    ...SESSIONS,
    runs: [{ ...first, runId: "run:other", studentDisplayName: "Other" }, first],
  });
  client.classes.mockResolvedValueOnce(other);
  await controller.start();
  expect(controller.state.updatedAt).toBe(1000);
  client.history.mockResolvedValueOnce(page("run:one"));
  await controller.select("run:one");
  expect(controller.state.selected).toEqual(first);
  const history = Promise.withResolvers<ReturnType<typeof page>>();
  client.history.mockReturnValueOnce(history.promise);
  vi.setSystemTime(2000);
  const refreshed = ClassSessionsResponseSchema.parse({
    ...other,
    runs: other.runs.map((run) =>
      run.runId === "run:one" ? { ...run, projectDisplayName: "Renamed" } : run,
    ),
  });
  client.classes.mockResolvedValueOnce(refreshed);
  const refresh = controller.refresh();
  await Promise.resolve();
  expect(controller.state.selected?.projectDisplayName).toBe("Renamed");
  expect(controller.state.updatedAt).toBe(1000);
  history.resolve(page("run:one", 1));
  await refresh;
  expect(controller.state.updatedAt).toBe(2000);
  client.classes.mockResolvedValueOnce({ ...SESSIONS, runs: [], nextBeforeRunId: null });
  await controller.more();
  expect(controller.state.selected?.projectDisplayName).toBe("Renamed");
  await controller.select(null);
  expect(controller.state.selected).toBeNull();
});
it("cancels existing timers, listing and history on disposal, including a pending manual refresh", async () => {
  vi.useFakeTimers();
  const { controller, client } = setup();
  await controller.start();
  expect(vi.getTimerCount()).toBe(1);
  const list = Promise.withResolvers<typeof SESSIONS>();
  client.classes.mockReturnValueOnce(list.promise);
  const refreshing = controller.refresh();
  expect(vi.getTimerCount()).toBe(0);
  const history = Promise.withResolvers<ReturnType<typeof page>>();
  client.history.mockReturnValueOnce(history.promise);
  const selecting = controller.select("run:one");
  controller.dispose();
  expect(client.classes.mock.lastCall?.[1].aborted).toBe(true);
  expect(client.history.mock.lastCall?.[3].aborted).toBe(true);
  list.resolve(SESSIONS);
  history.resolve(page("run:one"));
  await Promise.all([refreshing, selecting]);
  expect(vi.getTimerCount()).toBe(0);
  await controller.refresh();
  expect(client.classes).toHaveBeenCalledTimes(2);
});
it("retains data on server errors that are not authorization failures and notifies renderers", async () => {
  const { controller, client, changed } = setup();
  await controller.start();
  expect(changed).toHaveBeenCalled();
  client.history.mockResolvedValueOnce(page("run:one"));
  await controller.select("run:one");
  client.classes.mockRejectedValueOnce(new EvaluationRequestError(500));
  client.history.mockRejectedValueOnce(new EvaluationRequestError(500));
  await controller.refresh();
  expect(controller.state.runId).toBe("run:one");
  expect(controller.state.runs).toHaveLength(1);
  expect(controller.state.events).toHaveLength(1);
  expect(controller.state.connection).toBe("stale");
});
it("subscribes once to live invalidations and releases the subscription on disposal", async () => {
  vi.useFakeTimers();
  const callbacks: (() => void)[] = [];
  const unsubscribe = vi.fn();
  const client = {
    ...evaluationClientFixture(),
    classes: vi.fn().mockResolvedValue(SESSIONS),
    subscribe: vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return unsubscribe;
    }),
  };
  const controller = new SessionsController(client, notices, vi.fn());
  owned.push(controller);
  await controller.start();
  await controller.start();
  expect(client.subscribe).toHaveBeenCalledOnce();
  callbacks[0]?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.classes).toHaveBeenCalledTimes(3);
  controller.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  callbacks[0]?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.classes).toHaveBeenCalledTimes(3);
});
