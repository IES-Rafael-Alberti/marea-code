/// <reference lib="dom" />
import type { DashboardDataPort } from "./typed-dashboard-module.js";

/** A host-rendered view; the host adapter owns transport, authority checks and localization. */
export type DashboardHostView = (element: HTMLElement) => () => void;

/** Mounts a host view once its read resolves; cancellation and disposal prevent late rendering. */
export function mountDashboardHostView(
  element: HTMLElement,
  context: {
    readonly signal: AbortSignal;
    readonly data: Pick<DashboardDataPort<DashboardHostView>, "read">;
    readonly message: (key: string) => string;
  },
): () => void {
  let active = true;
  let dispose: (() => void) | undefined;
  const current = () => active && !context.signal.aborted;
  // A failed read and a view that throws while rendering both end in the localized state.
  void context.data
    .read(context.signal)
    .then((render) => {
      if (current()) dispose = render(element);
    })
    .catch(() => {
      if (current()) element.textContent = context.message("failed");
    });
  return () => {
    if (!active) return;
    active = false;
    if (dispose === undefined) element.replaceChildren();
    else dispose();
  };
}
