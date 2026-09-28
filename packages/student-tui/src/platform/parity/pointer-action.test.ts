import type { MouseEvent } from "@opentui/core";
import { expect, it, vi } from "vitest";
import { pointerAction } from "./pointer-action.js";
const event = (x = 2, y = 3, button = 0) => ({ x, y, button }) as MouseEvent;
it("activates exactly once on a left click, including a fresh click after a drag", () => {
  const activate = vi.fn();
  const handlers = pointerAction(activate);
  handlers.onMouseDown(event());
  expect(activate).not.toHaveBeenCalled();
  handlers.onMouseUp(event());
  handlers.onMouseUp(event());
  expect(activate).toHaveBeenCalledOnce();
  handlers.onMouseDown(event());
  handlers.onMouseDrag();
  handlers.onMouseUp(event());
  expect(activate).toHaveBeenCalledOnce();
  handlers.onMouseDown(event());
  handlers.onMouseUp(event());
  expect(activate).toHaveBeenCalledTimes(2);
});
it("ignores unmatched releases, moved pointers and other mouse buttons", () => {
  const activate = vi.fn();
  const handlers = pointerAction(activate);
  handlers.onMouseUp(event());
  for (const release of [event(4), event(2, 4), event(2, 3, 1)]) {
    handlers.onMouseDown(event());
    handlers.onMouseUp(release);
  }
  handlers.onMouseDown(event(2, 3, 1));
  handlers.onMouseUp(event());
  expect(activate).not.toHaveBeenCalled();
});

it("releases the pressed appearance on drag, leaving, other buttons and release", () => {
  const activate = vi.fn();
  const pressed = vi.fn();
  const handlers = pointerAction(activate, pressed);
  handlers.onMouseDown(event());
  expect(pressed).toHaveBeenLastCalledWith(true);
  handlers.onMouseOut();
  expect(pressed).toHaveBeenLastCalledWith(false);
  handlers.onMouseUp(event());
  expect(activate).not.toHaveBeenCalled();
  handlers.onMouseDown(event());
  handlers.onMouseDrag();
  expect(pressed).toHaveBeenLastCalledWith(false);
  handlers.onMouseDown(event(2, 3, 1));
  expect(pressed).toHaveBeenLastCalledWith(false);
  handlers.onMouseDown(event());
  handlers.onMouseUp(event());
  expect(pressed).toHaveBeenLastCalledWith(false);
  expect(activate).toHaveBeenCalledOnce();
});
