export type HookValue = object | string | number | boolean | null;
export interface StateHooks {
  values: HookValue[];
  index: number;
  effects: (() => (() => void) | undefined)[];
  dependencies: readonly (readonly (HookValue | undefined)[])[];
}
export function stateHarness() {
  const hooks: StateHooks = { values: [], index: 0, effects: [], dependencies: [] };
  const mockReact = async (original: () => Promise<typeof import("react")>) => ({
    ...(await original()),
    ...stateHooks(hooks),
  });
  return { hooks, mockReact };
}
export function stateHooks(hooks: StateHooks) {
  return {
    useState(initial: HookValue) {
      const index = hooks.index++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [
        hooks.values[index],
        (value: HookValue | ((previous: HookValue) => HookValue)) => {
          hooks.values[index] =
            typeof value === "function"
              ? (value as (previous: HookValue) => HookValue)(hooks.values[index] ?? null)
              : value;
        },
      ];
    },
    useEffect(
      effect: () => undefined | (() => void),
      dependencies: readonly (HookValue | undefined)[],
    ) {
      hooks.effects.push(effect);
      hooks.dependencies = [...hooks.dependencies, dependencies];
    },
  };
}
