import { afterEach, expect, it, vi } from "vitest";
import { Debounce } from "./debounce.js";

afterEach(() => {
  vi.useRealTimers();
});
it("runs only the latest action, once the wait passes without a newer one", () => {
  vi.useFakeTimers();
  const debounce = new Debounce(300);
  const first = vi.fn();
  const last = vi.fn();
  debounce.run(first);
  vi.advanceTimersByTime(299);
  debounce.run(last);
  vi.advanceTimersByTime(299);
  expect(last).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(last).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_000);
  expect(last).toHaveBeenCalledOnce();
});
it("drops a pending action when cancelled and can run again afterwards", () => {
  vi.useFakeTimers();
  const debounce = new Debounce(50);
  const dropped = vi.fn();
  const kept = vi.fn();
  debounce.run(dropped);
  debounce.cancel();
  vi.advanceTimersByTime(100);
  expect(dropped).not.toHaveBeenCalled();
  debounce.run(kept);
  vi.advanceTimersByTime(50);
  expect(kept).toHaveBeenCalledOnce();
});
