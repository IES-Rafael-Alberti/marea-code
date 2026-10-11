import { vi, type Mock } from "vitest";

export type WorkspaceShellValue = object | string | number | boolean | null | undefined;
type Value = WorkspaceShellValue;
type Effect = () => undefined | (() => void);

export function workspaceShellHarness() {
  const hooks = {
    state: [] as Value[],
    initials: [] as Value[],
    setters: [] as Mock[],
    refs: [] as { current: Value }[],
    effects: [] as Effect[],
    effectDependencies: [] as (readonly Value[])[],
    memoDependencies: [] as (readonly Value[])[],
    index: 0,
    refIndex: 0,
  };
  const mockReact = async (original: () => Promise<typeof import("react")>) => ({
    ...(await original()),
    useMemo: (create: () => object, dependencies: readonly Value[]) => {
      hooks.memoDependencies.push(dependencies);
      return create();
    },
    useRef: (current: Value) => (hooks.refs[hooks.refIndex++] ??= { current }),
    useEffect: (effect: Effect, dependencies: readonly Value[]) => {
      hooks.effects.push(effect);
      hooks.effectDependencies.push(dependencies);
    },
    useState: (initial: Value | (() => Value)) => {
      const index = hooks.index++;
      const value = typeof initial === "function" ? (initial as () => Value)() : initial;
      hooks.initials[index] = value;
      hooks.setters[index] ??= vi.fn();
      return [index in hooks.state ? hooks.state[index] : value, hooks.setters[index]];
    },
  });
  return { hooks, mockReact };
}
