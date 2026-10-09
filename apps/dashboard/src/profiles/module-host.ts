import type {
  DashboardModuleBrowserEntry,
  DashboardModuleContext,
} from "@marea/plugin-api/browser";
import { abortScope } from "./abort-scope.js";

/** One mounted module owns every request/subscription and cannot deliver after disposal. */
export async function mountDashboardModule<Settings extends object, Data>(
  element: HTMLElement,
  load: () => Promise<{ default: DashboardModuleBrowserEntry<Settings, Data> }>,
  context: DashboardModuleContext<Settings, Data>,
  failed: () => void,
): Promise<() => void> {
  const lifetime = new AbortController();
  const isActive = () => !lifetime.signal.aborted;
  let unmount: (() => void) | undefined;
  const dispose = () => {
    lifetime.abort();
    const stop = unmount;
    unmount = undefined;
    stop?.();
    context.signal.removeEventListener("abort", dispose);
  };
  context.signal.addEventListener("abort", dispose, { once: true });
  if (context.signal.aborted) {
    dispose();
    return dispose;
  }
  const subscribe = context.ports.subscribe;
  const ports: DashboardModuleContext<Settings, Data>["ports"] = {
    ...context.ports,
    async read(signal) {
      const scope = abortScope([signal, lifetime.signal]);
      try {
        scope.signal.throwIfAborted();
        const data = await context.ports.read(scope.signal);
        scope.signal.throwIfAborted();
        return data;
      } finally {
        scope.dispose();
      }
    },
    ...(subscribe === undefined
      ? {}
      : {
          subscribe(signal: AbortSignal, receive: (data: Data) => void) {
            const scope = abortScope([signal, lifetime.signal]);
            const combined = scope.signal;
            combined.throwIfAborted();
            let active = true;
            let unsubscribe: () => void;
            try {
              unsubscribe = subscribe(combined, (data) => {
                if (active && !combined.aborted) receive(data);
              });
            } catch (error) {
              scope.dispose();
              throw error;
            }
            const stop = () => {
              if (!active) return;
              active = false;
              combined.removeEventListener("abort", stop);
              scope.dispose();
              unsubscribe();
            };
            combined.addEventListener("abort", stop);
            if (combined.aborted) stop();
            return stop;
          },
        }),
  };
  try {
    const entry = await load();
    if (isActive()) {
      const stop = entry.default.mount(element, { ...context, signal: lifetime.signal, ports });
      if (!isActive()) stop();
      else unmount = stop;
    }
  } catch {
    if (isActive()) {
      dispose();
      failed();
    }
  }
  return dispose;
}
