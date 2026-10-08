import { afterEach, expect, it, vi } from "vitest";
import { useFormDraft } from "./use-form-draft.js";
const hooks = vi.hoisted(() => ({ effect: vi.fn() }));
vi.mock("react", () => ({ useEffect: hooks.effect }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("only protects dirty forms and removes the exact listener on disposal", () => {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", { addEventListener, removeEventListener });
  for (const dirty of [false, true]) {
    useFormDraft(dirty);
    expect(hooks.effect.mock.lastCall?.[1]).toEqual([dirty]);
    const cleanup = (hooks.effect.mock.lastCall?.[0] as () => () => void)();
    const listener = addEventListener.mock.lastCall?.[1] as (event: object) => void;
    expect(addEventListener).toHaveBeenLastCalledWith("beforeunload", listener);
    const preventDefault = vi.fn();
    listener({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(dirty ? 1 : 0);
    cleanup();
    expect(removeEventListener).toHaveBeenLastCalledWith("beforeunload", listener);
  }
});
