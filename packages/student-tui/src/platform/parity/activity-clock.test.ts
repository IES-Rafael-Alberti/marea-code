import { afterEach, expect, it, vi } from "vitest";
import { INITIAL_STATUS } from "../../parity/status.js";
const hooks = vi.hoisted(() => ({
  elapsed: 0,
  dependencies: [] as unknown[],
  effect: undefined as (() => (() => void) | undefined) | undefined,
}));
vi.mock("react", () => ({
  useState: (initial: number) => {
    expect(initial).toBe(0);
    return [
      hooks.elapsed,
      (value: number) => {
        hooks.elapsed = value;
      },
    ];
  },
  useEffect: (effect: typeof hooks.effect, dependencies: unknown[]) => {
    hooks.effect = effect;
    hooks.dependencies = dependencies;
  },
}));
import { useActivityClock } from "./activity-clock.js";
afterEach(() => vi.useRealTimers());
it("counts seconds per activity, resets on transitions and stops while waiting or unmounted", () => {
  vi.useFakeTimers();
  const status = { ...INITIAL_STATUS, elapsedMs: 300 };
  expect(useActivityClock(status)).toEqual(status);
  expect(hooks.dependencies).toEqual([true, "starting", ""]);
  const dispose = hooks.effect?.();
  vi.advanceTimersByTime(999);
  expect(useActivityClock(status).elapsedMs).toBe(300);
  vi.advanceTimersByTime(1);
  expect(useActivityClock(status).elapsedMs).toBe(1300);
  vi.advanceTimersByTime(1000);
  expect(useActivityClock(status).elapsedMs).toBe(2300);
  dispose?.();
  useActivityClock({ ...status, activity: "tool", toolName: "read_file" });
  expect(hooks.dependencies).toEqual([true, "tool", "read_file"]);
  const nextDispose = hooks.effect?.();
  expect(hooks.elapsed).toBe(0);
  nextDispose?.();
  const waiting = { ...status, elapsedMs: null };
  expect(useActivityClock(waiting)).toEqual(waiting);
  expect(hooks.dependencies).toEqual([false, "starting", ""]);
  expect(hooks.effect?.()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
