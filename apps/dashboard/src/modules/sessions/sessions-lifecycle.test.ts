import { afterEach, expect, it, vi } from "vitest";
import { ClassSessionsResponseSchema } from "@marea/protocol";
import { SessionsController } from "./sessions-controller.js";
import { EvaluationRequestError } from "../evaluation/evaluation-client.boundary.js";
import { evaluationClientFixture, HISTORY, SESSIONS } from "../evaluation/evaluation.fixture.js";
const page = ClassSessionsResponseSchema.parse({
  ...SESSIONS,
  kind: "class-sessions-response",
  runs: SESSIONS.runs.map((run) => ({ ...run, classId: "class:one" })),
});
const controllers: SessionsController[] = [];
afterEach(() => {
  controllers.forEach((controller) => {
    controller.dispose();
  });
  controllers.length = 0;
  vi.useRealTimers();
});
function workspace() {
  const client = { ...evaluationClientFixture(), classes: vi.fn().mockResolvedValue(page) };
  client.history.mockResolvedValue(HISTORY);
  const controller = new SessionsController(client, { publish: vi.fn(), query: vi.fn() }, vi.fn());
  controllers.push(controller);
  return { client, controller };
}
it("selects before initial listing and clears earlier read failures on a new class or session", async () => {
  const { client, controller } = workspace();
  await controller.select("run:one");
  expect(controller.state.connection).toBe("current");
  client.history.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  const history = Promise.withResolvers<typeof HISTORY>();
  client.history.mockReturnValueOnce(history.promise);
  const selecting = controller.select("run:two");
  expect(controller.state.catchingUp).toBe(false);
  await controller.refresh();
  expect(controller.state.connection).toBe("loading");
  history.resolve({ ...HISTORY, runId: HISTORY.runId });
  await selecting;
  const listing = Promise.withResolvers<typeof page>();
  client.classes.mockReturnValueOnce(listing.promise);
  const refreshed = controller.refresh();
  await Promise.resolve();
  listing.resolve(page);
  await refreshed;
  expect(controller.state.connection).toBe("current");
  client.classes.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  const classListing = Promise.withResolvers<typeof page>();
  client.classes.mockReturnValueOnce(classListing.promise);
  const choosing = controller.chooseClass("class:two");
  await controller.select("run:one");
  expect(controller.state.connection).toBe("current");
  classListing.resolve(page);
  await choosing;
});
it("lets a recovered listing clear stale status while another history read is pending", async () => {
  const { client, controller } = workspace();
  await controller.select("run:one");
  client.classes.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  expect(controller.state.connection).toBe("stale");
  const history = Promise.withResolvers<typeof HISTORY>();
  client.history.mockReturnValueOnce(history.promise);
  const refreshed = controller.refresh();
  await Promise.resolve();
  expect(controller.state.connection).toBe("current");
  history.resolve(HISTORY);
  await refreshed;
});
it("does not let an old page completion unlock a newer page load", async () => {
  const { client, controller } = workspace();
  await controller.start();
  const oldPage = Promise.withResolvers<typeof page>();
  const newPage = Promise.withResolvers<typeof page>();
  client.classes.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise);
  const old = controller.newest();
  const current = controller.more();
  const oldSignal = client.classes.mock.calls.at(-2)?.[1] as AbortSignal;
  expect(oldSignal.aborted).toBe(true);
  oldPage.resolve(page);
  await old;
  expect(controller.state.moreBusy).toBe(true);
  newPage.resolve(page);
  await current;
  expect(controller.state.moreBusy).toBe(false);
});
it("cancels a scheduled poll and disposes retained drafts when the dashboard closes", async () => {
  vi.useFakeTimers();
  const { controller } = workspace();
  await controller.start();
  await controller.select("run:one");
  await controller.openEvaluation();
  const notice = controller.notice;
  if (notice === undefined) throw new Error("Missing notice");
  const dispose = vi.spyOn(notice, "dispose");
  expect(vi.getTimerCount()).toBe(1);
  controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(dispose).toHaveBeenCalledOnce();
});
it.each(["history", "list"] as const)(
  "discards cached drafts after %s access revocation and creates fresh ones on renewed access",
  async (source) => {
    const { client, controller } = workspace();
    await controller.start();
    await controller.select("run:one");
    await controller.openEvaluation();
    const before = controller.notice;
    before?.edit("Confidential draft");
    if (source === "history") client.history.mockRejectedValueOnce(new EvaluationRequestError(403));
    else client.classes.mockRejectedValueOnce(new EvaluationRequestError(403));
    await controller.refresh();
    expect(controller.state.connection).toBe("stale");
    await controller.select("run:one");
    expect(controller.notice).not.toBe(before);
    expect(controller.notice?.state.draft).toBe("");
    expect(controller.review).toBeUndefined();
  },
);
