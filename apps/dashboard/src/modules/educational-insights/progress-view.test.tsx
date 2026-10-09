import { afterEach, expect, it, vi } from "vitest";
import { StudentProgress } from "./progress-view.js";
import { button, elements, model, props, criterion } from "./interactions.fixture.js";
const hooks = vi.hoisted(() => ({ values: [] as (string | number)[], index: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: string | number) => {
    const index = hooks.index++;
    hooks.values[index] ??= initial;
    return [
      hooks.values[index],
      (value: string | number) => {
        hooks.values[index] = value;
      },
    ];
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  hooks.values = [];
});
const student = {
  id: "student",
  displayName: "Ana",
  revision: "v1",
  entries: [
    criterion,
    { ...criterion, key: "next" },
    { ...criterion, key: "other", skillId: "other" },
  ],
};
function render(state: ReturnType<typeof model>, value = student) {
  hooks.index = 0;
  return StudentProgress({ student: value, open: false, model: state, props });
}

it("keeps the adjustment reason and level per student and resets a whole skill after confirming", () => {
  vi.spyOn(Map, "groupBy").mockImplementation(() => {
    throw new Error("Unavailable in Safari 17.1");
  });
  const state = model();
  const empty = elements(render(state, { ...student, entries: [] }));
  expect(empty.at(-1)?.props.children).toBe(state.m.noProgress);
  expect(empty.map((e) => e.type)).toEqual(["details", "summary", "strong", "span"]);
  expect(button(render(state), state.m.setLevel).disabled).toBe(true);
  const controls = () => elements(render(state)).filter((e) => e.props.onChange !== undefined);
  controls()[0]?.props.onChange?.({ currentTarget: { value: "   ", checked: false } });
  expect(button(render(state), state.m.setLevel).disabled).toBe(true);
  controls()[0]?.props.onChange?.({ currentTarget: { value: "Evidence", checked: false } });
  controls()[1]?.props.onChange?.({ currentTarget: { value: "3", checked: false } });
  expect(controls().map((e) => e.props.value)).toEqual(["Evidence", 3]);
  expect(button(render(state), state.m.setLevel).disabled).toBe(false);
  expect(
    elements(render(state))
      .filter((e) => e.type === "option")
      .map((e) => e.props.value),
  ).toEqual([0, 1, 2, 3, 4]);
  button(render(state), state.m.setLevel).onClick?.();
  expect(state.action).toHaveBeenLastCalledWith({
    kind: "adjust",
    studentId: "student",
    keys: ["key"],
    level: 3,
    reason: "Evidence",
    expectedRevision: "v1",
  });
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("window", { confirm });
  button(render(state), state.m.resetSkill).onClick?.();
  expect(confirm).toHaveBeenCalledWith(state.m.confirmReset);
  expect(state.action).toHaveBeenCalledTimes(1);
  confirm.mockReturnValue(true);
  button(render(state), state.m.resetSkill).onClick?.();
  expect(state.action).toHaveBeenLastCalledWith(
    expect.objectContaining({ keys: ["key", "next"], level: 0 }),
  );
  state.busy = true;
  expect(button(render(state), state.m.setLevel).disabled).toBe(true);
  expect(button(render(state), state.m.resetSkill).disabled).toBe(true);
});

it("groups every criterion by skill in encounter order without Map.groupBy", () => {
  const state = model();
  const sections = elements(render(state)).filter((element) => element.type === "section");
  expect(sections).toHaveLength(2);
  const headings = elements(render(state)).filter((element) => element.type === "h3");
  expect(headings.map((element) => element.props.children)).toEqual([criterion.skillId, "other"]);
  const reset = elements(render(state)).filter(
    (element) => element.type === "button" && element.props.children === state.m.resetSkill,
  );
  vi.stubGlobal("window", { confirm: () => true });
  for (const control of reset) control.props.onClick?.();
  expect(state.action).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ keys: ["key", "next"] }),
  );
  expect(state.action).toHaveBeenNthCalledWith(2, expect.objectContaining({ keys: ["other"] }));
});
