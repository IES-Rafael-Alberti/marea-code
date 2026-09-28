import type { MouseEvent } from "@opentui/core";

export type PointerOrigin = { x: number; y: number } | null;

/** Activate on release, preserving text selection and ignoring other buttons. */
export function pointerAction(
  activate: () => void,
  pressed?: (value: boolean) => void,
  state: { origin?: PointerOrigin } = {},
) {
  const cancel = () => {
    state.origin = null;
    pressed?.(false);
  };
  return {
    onMouseDown(event: MouseEvent) {
      state.origin = event.button === 0 ? { x: event.x, y: event.y } : null;
      pressed?.(state.origin !== null);
    },
    onMouseOut: cancel,
    onMouseDrag: cancel,
    onMouseDragEnd: cancel,
    onMouseUp(event: MouseEvent) {
      const start = state.origin;
      state.origin = null;
      pressed?.(false);
      if (event.button === 0 && start?.x === event.x && start.y === event.y) activate();
    },
  };
}
