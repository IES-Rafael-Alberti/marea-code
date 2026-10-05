import { afterEach, beforeEach, vi } from "vitest";
import type { FunctionComponent, ReactNode, ReactElement } from "react";
type HookValue = object | string | number | boolean | null;
const hooks = vi.hoisted(() => ({
  values: [] as HookValue[],
  index: 0,
  refs: [] as { current: HookValue }[],
  refIndex: 0,
  dependencies: [] as (readonly HookValue[] | undefined)[],
  effects: [] as (() => undefined | (() => void))[],
}));
const mocked = vi.hoisted(() => ({ client: vi.fn(), model: vi.fn() }));
vi.mock("./client.js", () => ({ insightsClient: () => mocked.client }));
vi.mock("./model.js", () => ({ useInsightModel: mocked.model }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: HookValue) => {
    const i = hooks.index++;
    if (!(i in hooks.values)) hooks.values[i] = initial;
    return [
      hooks.values[i],
      (value: HookValue) => {
        hooks.values[i] =
          typeof value === "function"
            ? (value as (previous: HookValue) => HookValue)(hooks.values[i] ?? null)
            : value;
      },
    ];
  },
  useRef: (initial: HookValue) => {
    const i = hooks.refIndex++;
    return (hooks.refs[i] ??= { current: initial });
  },
  useEffect: (effect: () => undefined | (() => void), dependencies?: readonly HookValue[]) => {
    hooks.dependencies.push(dependencies);
    hooks.effects.push(effect);
  },
}));
export function render<T>(component: () => T): T {
  hooks.index = 0;
  hooks.refIndex = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  return component();
}
export function content(element: ReactElement): ReactNode {
  if (typeof element.type !== "function") throw new Error("Expected function component");
  const component = element.type as FunctionComponent<object>;
  const result = component(element.props as object);
  if (result instanceof Promise) throw new Error("Expected synchronous component");
  return result;
}
beforeEach(() => {
  hooks.values = [];
  hooks.refs = [];
  hooks.effects = [];
  hooks.dependencies = [];
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

export { hooks, mocked };
