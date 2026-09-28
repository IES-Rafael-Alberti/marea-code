import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderedText } from "../../../test-support/element-tree.boundary.js";
const hooks = vi.hoisted(() => ({
  dependencies: [] as (string | EventEmitter)[],
  value: null as string | null,
  effect: undefined as (() => () => void) | undefined,
  renderer: undefined as EventEmitter | undefined,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [
    hooks.value,
    (value: string | null) => {
      hooks.value = value;
    },
  ],
  useEffect: (effect: () => () => void, dependencies: (string | EventEmitter)[]) => {
    hooks.dependencies = dependencies;
    hooks.effect = effect;
  },
}));
vi.mock("@opentui/react", () => ({ useRenderer: () => hooks.renderer }));
import { ClipboardNotice } from "./clipboard-notice.js";
beforeEach(() => {
  vi.useFakeTimers();
  hooks.value = null;
  hooks.renderer = new EventEmitter();
});
afterEach(() => vi.useRealTimers());
it("shows copy and quit feedback for 1.5 seconds, restarts its deadline and cleans up", () => {
  const renderer = hooks.renderer;
  if (renderer === undefined) throw new Error("Missing test renderer");
  const render = () => ClipboardNotice({ text: "Copied", quitHint: "Use Ctrl+D" });
  expect(render()).toBeNull();
  expect(hooks.dependencies).toEqual([renderer, "Copied", "Use Ctrl+D"]);
  const cleanup = hooks.effect?.();
  renderer.emit("marea:copied");
  expect(renderedText(render())).toBe("Copied");
  vi.advanceTimersByTime(1000);
  renderer.emit("marea:quit-hint");
  expect(renderedText(render())).toBe("Use Ctrl+D");
  vi.advanceTimersByTime(1499);
  expect(renderedText(render())).toBe("Use Ctrl+D");
  vi.advanceTimersByTime(1);
  expect(render()).toBeNull();
  renderer.emit("marea:copied");
  cleanup?.();
  expect(renderer.listenerCount("marea:copied")).toBe(0);
  expect(renderer.listenerCount("marea:quit-hint")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
