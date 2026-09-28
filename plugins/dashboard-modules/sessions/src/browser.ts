import type { DashboardModuleBrowserEntry } from "@marea/plugin-api/browser";

/** The shell supplies the existing session/review renderer through the public data port. */
export type SessionView = (element: HTMLElement) => () => void;
const entry: DashboardModuleBrowserEntry<object, SessionView> = {
  mount(element, context) {
    let dispose: (() => void) | undefined;
    let active = true;
    if (context.classId === null) {
      element.textContent = context.ports.message("selectClass");
    } else {
      element.textContent = context.ports.message("loading");
      void context.ports
        .read(context.signal)
        .then((render) => {
          if (active && !context.signal.aborted) dispose = render(element);
        })
        .catch(() => {
          if (active && !context.signal.aborted)
            element.textContent = context.ports.message("failed");
        });
    }
    return () => {
      if (!active) return;
      active = false;
      if (dispose === undefined) element.replaceChildren();
      else dispose();
    };
  },
};
export default entry;

/** Additive typed entry; the default export retains the 2.0 browser contract. */
export const typedEntry: import("@marea/plugin-api/browser").TypedDashboardModuleBrowserEntry<
  object,
  SessionView,
  never,
  { readonly sessionReview: true }
> = {
  mount(element, context) {
    return entry.mount(element, {
      ...context,
      ports: { ...context.data, message: context.message, navigate: () => Promise.resolve(false) },
    });
  },
};
