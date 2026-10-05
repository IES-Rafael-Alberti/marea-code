type HookValue = object | string | number | boolean | null;

/** Hook slots of a rendered component: each keeps its value across renders. */
export const hooks = {
  values: [] as HookValue[],
  index: 0,
  effects: [] as (() => undefined | (() => void))[],
  dependencies: [] as (readonly HookValue[])[],
};

function slot(initial: HookValue): [HookValue, (value: HookValue) => void] {
  const position = hooks.index;
  hooks.index += 1;
  if (!(position in hooks.values)) hooks.values[position] = initial;
  return [
    hooks.values[position] ?? null,
    (value) => {
      hooks.values[position] = value;
    },
  ];
}

/** React with recorded effects and slot state, so views render as plain functions. */
export function stubbedReact<T extends object>(react: T): T {
  return {
    ...react,
    useEffect: (run: () => undefined | (() => void), dependencies: readonly HookValue[]) => {
      hooks.effects.push(run);
      hooks.dependencies.push(dependencies);
    },
    useState: slot,
  };
}
