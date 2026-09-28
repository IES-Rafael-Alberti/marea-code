import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ClassSessionsResponseSchema } from "@marea/protocol";
import { SessionsModule } from "./sessions-module.js";
import { SessionsController } from "./sessions-controller.js";
import { sessionsMessages } from "./sessions-messages.js";
import { evaluationClientFixture, SESSIONS, HISTORY } from "../evaluation/evaluation.fixture.js";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";

const hooks = vi.hoisted(() => ({
  values: ["", "all", "conversation", false] as (string | boolean)[],
  index: 0,
  refIndex: 0,
  setters: [vi.fn(), vi.fn(), vi.fn(), vi.fn()],
  effects: [] as (() => void)[],
  dependencies: [] as readonly (readonly (string | number | null)[])[],
  initialRefs: [] as (boolean | null)[],
  scroll: {
    current: null as null | { scrollTop: number; scrollHeight: number; clientHeight: number },
  },
  follow: { current: true },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => {
    const index = hooks.index++;
    return [hooks.values[index], hooks.setters[index]];
  },
  useRef: (initial: boolean | null) => {
    hooks.initialRefs.push(initial);
    return hooks.refIndex++ === 0 ? hooks.scroll : hooks.follow;
  },
  useEffect: (effect: () => void, dependencies: readonly (string | number | null)[]) => {
    hooks.effects.push(effect);
    hooks.dependencies = [...hooks.dependencies, dependencies];
  },
}));
afterEach(() => {
  hooks.values = ["", "all", "conversation", false];
  hooks.scroll.current = null;
  hooks.follow.current = true;
  vi.clearAllMocks();
});
function setup() {
  const client = { ...evaluationClientFixture(), classes: vi.fn() };
  const controller = new SessionsController(client, { publish: vi.fn(), query: vi.fn() }, vi.fn());
  const page = ClassSessionsResponseSchema.parse({
    ...SESSIONS,
    kind: "class-sessions-response",
    runs: SESSIONS.runs.map((run) => ({ ...run, classId: "class:one" })),
  });
  controller.state = { ...controller.state, runs: page.runs, next: "run:older" };
  const render = () => {
    hooks.index = 0;
    hooks.refIndex = 0;
    hooks.effects = [];
    hooks.dependencies = [];
    hooks.initialRefs = [];
    return reviewElements(
      SessionsModule({
        locale: "es",
        controller,
        classes: [{ classId: "class:one", displayName: "Physics" }],
      }),
    );
  };
  return { controller, render };
}
it("routes class, page, search and session selection without conflating their filters", () => {
  const { controller, render } = setup();
  const choose = vi.spyOn(controller, "chooseClass").mockResolvedValue();
  const select = vi.spyOn(controller, "select").mockResolvedValue();
  const newest = vi.spyOn(controller, "newest").mockResolvedValue();
  const more = vi.spyOn(controller, "more").mockResolvedValue();
  const elements = render();
  const selects = elements.filter((element) => element.type === "select");
  selects[0]?.props.onChange?.({ currentTarget: { value: "class:one" } });
  selects[0]?.props.onChange?.({ currentTarget: { value: "" } });
  expect(choose.mock.calls).toEqual([["class:one"], [null]]);
  elements
    .find((element) => element.type === "input")
    ?.props.onChange?.({ currentTarget: { value: "Ada" } });
  expect(hooks.setters[0]).toHaveBeenCalledWith("Ada");
  selects[1]?.props.onChange?.({ currentTarget: { value: "closed" } });
  expect(hooks.setters[1]).toHaveBeenCalledWith("closed");
  const card = elements.find((element) => element.type === "li");
  reviewElements(card?.props.children)
    .find((element) => element.type === "button")
    ?.props.onClick?.();
  expect(select).toHaveBeenCalledWith("run:one");
  const m = sessionsMessages("es");
  reviewButton(elements, m.newest).props.onClick?.();
  reviewButton(elements, m.more).props.onClick?.();
  expect(newest).toHaveBeenCalledOnce();
  expect(more).toHaveBeenCalledOnce();
  hooks.values = ["missing", "all", "conversation", false];
  expect(render().filter((element) => element.type === "li")).toHaveLength(0);
  hooks.values = ["", "active", "conversation", false];
  expect(render().filter((element) => element.type === "li")).toHaveLength(0);
  hooks.values = ["aDA", "closed", "conversation", false];
  expect(render().filter((element) => element.type === "li")).toHaveLength(1);
  controller.state = { ...controller.state, moreBusy: true, next: null };
  expect(reviewButton(render(), m.more).props.disabled).toBe(true);
  expect(reviewButton(render(), m.newest).props.disabled).toBe(true);
  controller.state = {
    ...controller.state,
    runs: controller.state.runs.map((run) => ({ ...run, state: "active" })),
  };
  hooks.values[1] = "all";
  expect(render().find((element) => element.type === "small")?.props.children).toContain("Abierta");
  controller.dispose();
});
it("keeps conversation and evaluation contextual and supports returning to the list", async () => {
  const { controller, render } = setup();
  await controller.select("run:one");
  const open = vi.spyOn(controller, "openEvaluation");
  const m = sessionsMessages("es");
  let elements = render();
  reviewButton(elements, m.evaluation).props.onClick?.();
  expect(hooks.setters[2]).toHaveBeenCalledWith("evaluation");
  expect(open).toHaveBeenCalledOnce();
  await controller.openEvaluation();
  hooks.values[2] = "evaluation";
  elements = render();
  reviewButton(elements, m.conversation).props.onClick?.();
  expect(hooks.setters[2]).toHaveBeenCalledWith("conversation");
  controller.state = { ...controller.state, events: [], catchingUp: true };
  render();
  reviewButton(elements, m.back).props.onClick?.();
  expect(controller.state.runId).toBeNull();
  controller.dispose();
});
it("follows new messages only when already at the bottom and explicitly resumes on request", async () => {
  const { controller, render } = setup();
  await controller.select("run:one");
  controller.state = { ...controller.state, events: HISTORY.events };
  render();
  hooks.effects[1]?.();
  expect(hooks.setters[3]).not.toHaveBeenCalled();
  const scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
  hooks.scroll.current = scroll;
  hooks.effects[1]?.();
  expect(scroll.scrollTop).toBe(1000);
  interface ScrollProperties {
    onScroll: (event: { currentTarget: typeof scroll }) => void;
  }
  const elements = render();
  expect(hooks.dependencies).toEqual([["run:one"], [HISTORY.events.length]]);
  expect(hooks.initialRefs).toEqual([null, true]);
  const scroller = elements.find(
    (element) => element.type === "div" && "onScroll" in element.props,
  ) as ReactElement<ScrollProperties>;
  hooks.setters[3]?.mockClear();
  scroll.scrollTop = 200;
  scroller.props.onScroll({ currentTarget: scroll });
  expect(hooks.follow.current).toBe(false);
  expect(hooks.setters[3]).not.toHaveBeenCalled();
  hooks.effects[1]?.();
  expect(scroll.scrollTop).toBe(200);
  expect(hooks.setters[3]).toHaveBeenLastCalledWith(true);
  hooks.values[3] = true;
  reviewButton(render(), sessionsMessages("es").latest).props.onClick?.();
  expect(hooks.follow.current).toBe(true);
  expect(hooks.setters[3]).toHaveBeenLastCalledWith(false);
  expect(scroll.scrollTop).toBe(1000);
  hooks.setters[3]?.mockClear();
  scroll.scrollTop = 753;
  scroller.props.onScroll({ currentTarget: scroll });
  expect(hooks.follow.current).toBe(true);
  expect(hooks.setters[3]).toHaveBeenLastCalledWith(false);
  scroll.scrollTop = 752;
  scroller.props.onScroll({ currentTarget: scroll });
  expect(hooks.follow.current).toBe(false);
  hooks.scroll.current = null;
  reviewButton(render(), sessionsMessages("es").latest).props.onClick?.();
  hooks.follow.current = false;
  hooks.effects[0]?.();
  expect(hooks.setters[3]).toHaveBeenLastCalledWith(false);
  expect(hooks.follow.current).toBe(true);
  expect(hooks.setters[2]).toHaveBeenLastCalledWith("conversation");
  controller.dispose();
});

interface ViewAttributes {
  readonly className?: string;
  readonly hidden?: boolean;
  readonly children?: ReactNode;
  readonly "aria-pressed"?: boolean;
}
it("renders only the selected conversation/evaluation tab and never invents missing controllers", async () => {
  const { controller, render } = setup();
  await controller.select("run:one");
  const m = sessionsMessages("es");
  let elements = render() as readonly ReactElement<ViewAttributes>[];
  const panelVisibility = () =>
    elements
      .filter((element) => element.type === "div" && typeof element.props.hidden === "boolean")
      .map((element) => element.props.hidden);
  const pressed = () =>
    elements
      .filter(
        (element) =>
          element.type === "button" &&
          [m.conversation, m.evaluation].includes(element.props.children as string),
      )
      .map((element) => element.props["aria-pressed"]);
  expect(panelVisibility()).toEqual([false, true]);
  expect(pressed()).toEqual([true, false]);
  expect(elements.some((element) => element.props.children === m.nothing)).toBe(false);
  await controller.openEvaluation();
  hooks.values[2] = "evaluation";
  elements = render() as readonly ReactElement<ViewAttributes>[];
  expect(panelVisibility()).toEqual([true, false]);
  expect(pressed()).toEqual([false, true]);
  expect(elements.some((element) => element.props.className === "evaluation-actions")).toBe(true);
  controller.state = { ...controller.state, runId: "run:missing", events: [] };
  elements = render() as readonly ReactElement<ViewAttributes>[];
  expect(elements.some((element) => element.props.children === m.nothing)).toBe(true);
  expect(elements.some((element) => element.props.className === "notice-composer")).toBe(false);
  expect(elements.some((element) => element.props.className === "evaluation-actions")).toBe(false);
  controller.dispose();
});
