import { skillWorkspaceMessages } from "./messages.js";
import { stateHarness } from "../server-settings/state-hooks.fixture.js";
export function viewHooks() {
  const base = stateHarness();
  const refs = { index: 0, values: [] as { current: object | null }[] };
  return {
    m: skillWorkspaceMessages("en"),
    hooks: base.hooks,
    refs,
    resetRender: () => {
      base.hooks.index = 0;
      base.hooks.effects = [];
      refs.index = 0;
    },
    mockReact: async (original: () => Promise<typeof import("react")>) => ({
      ...(await base.mockReact(original)),
      useRef: (initial: object | null) => {
        const index = refs.index++;
        refs.values[index] ??= { current: initial };
        return refs.values[index];
      },
    }),
  };
}
