import { hooks, mocked, render } from "./hooks.fixture.js";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CriterionHistory } from "./history-view.js";
import { button, elements, model } from "./interactions.fixture.js";
const entry = {
  id: 1,
  runId: null,
  previousLevel: 0,
  level: 1,
  reason: "Practice",
  actor: "teacher",
  createdAt: "now",
};
const history = () =>
  CriterionHistory({
    client: mocked.client,
    classId: "class:a",
    studentId: "student",
    criterionKey: "key",
    locale: "es",
  });
it("loads history, appends another page and replaces it on refresh", async () => {
  const m = model().m;
  mocked.client
    .mockResolvedValueOnce({
      entries: Array.from({ length: 51 }, (_, i) => ({ ...entry, id: i + 1 })),
    })
    .mockResolvedValueOnce({ entries: [{ ...entry, id: 52 }] })
    .mockResolvedValueOnce({ entries: [] });
  let view = render(history);
  expect(hooks.values).toEqual([[], false, false, false, false]);
  expect(hooks.dependencies).toEqual([[]]);
  expect(renderToStaticMarkup(view)).not.toContain('role="alert"');
  expect(renderToStaticMarkup(view)).not.toContain("<ol>");
  const dispose = hooks.effects[0]?.();
  button(view, m.history).onClick?.();
  expect(button(render(history), m.history).disabled).toBe(true);
  expect(mocked.client.mock.lastCall?.[1]).toEqual({
    kind: "history",
    studentId: "student",
    key: "key",
    after: 0,
  });
  await vi.advanceTimersByTimeAsync(1);
  view = render(history);
  expect(elements(view).filter((e) => e.type === "li")).toHaveLength(51);
  button(view, m.more).onClick?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocked.client.mock.lastCall?.[1]).toMatchObject({ after: 51 });
  expect(elements(render(history)).filter((e) => e.type === "li")).toHaveLength(52);
  expect(
    elements(render(history)).filter((e) => e.type === "button" && e.props.children === m.more),
  ).toHaveLength(0);
  button(render(history), m.history).onClick?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(elements(render(history)).filter((e) => e.type === "li")).toHaveLength(0);
  if (typeof dispose === "function") dispose();
  expect((mocked.client.mock.lastCall?.[3] as AbortSignal).aborted).toBe(true);
});
it.each([false, true])("does not publish history after unmount (failure: %s)", async (failure) => {
  const pending = Promise.withResolvers<object>();
  mocked.client.mockReturnValue(pending.promise);
  const view = render(history);
  const dispose = hooks.effects[0]?.();
  button(view, model().m.history).onClick?.();
  if (typeof dispose === "function") dispose();
  if (failure) pending.reject(new Error("offline"));
  else pending.resolve({ entries: [entry] });
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[0]).toEqual([]);
  expect(hooks.values[2]).toBe(true);
  expect(hooks.values[3]).toBe(false);
});
it("shows a history failure and permits retry", async () => {
  mocked.client.mockRejectedValue(new Error("offline"));
  button(render(history), model().m.history).onClick?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[3]).toBe(true);
  expect(renderToStaticMarkup(render(history))).toContain('role="alert"');
  expect(button(render(history), model().m.history).disabled).toBe(false);
});
