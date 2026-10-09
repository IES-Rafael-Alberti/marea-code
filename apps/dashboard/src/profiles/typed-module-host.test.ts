import { expect, it, vi } from "vitest";
import type { TypedDashboardModuleContext } from "@marea/plugin-api/browser";
import { bindDashboardModule } from "./typed-module-host.js";

type Context = TypedDashboardModuleContext<
  { units: "books" },
  { titles: string[] },
  { shelf: number },
  { canRead: boolean }
>;
function fixture() {
  const abort = new AbortController();
  const environment = {
    classId: "class:library",
    locale: "eu" as const,
    timeRange: { from: "a", to: "b" },
    signal: abort.signal,
  };
  const read = vi.fn().mockResolvedValue({ titles: ["Synthetic book"] });
  const navigate = vi.fn<Context["navigation"]["navigate"]>().mockResolvedValue(true);
  const unsubscribe = vi.fn();
  let receive: (data: { titles: string[] }) => void = () => undefined;
  const source: Context = {
    ...environment,
    settings: { units: "books" },
    placement: { slot: "aside", size: "compact" },
    capabilities: { canRead: true },
    message: (key) => key,
    navigation: { navigate },
    data: {
      read,
      subscribe: (_signal, callback) => {
        receive = callback;
        return unsubscribe;
      },
    },
  };
  const stop = vi.fn();
  const mount = vi
    .fn<(element: HTMLElement, context: Context) => () => void>()
    .mockReturnValue(stop);
  const failed = vi.fn();
  const binding = bindDashboardModule(
    () => Promise.resolve({ default: { mount } }),
    () => source,
  );
  const element = {} as HTMLElement;
  return {
    abort,
    environment,
    source,
    read,
    navigate,
    unsubscribe,
    receive: (titles: string[]) => {
      receive({ titles });
    },
    stop,
    mount,
    failed,
    binding,
    element,
  };
}
it("pairs unrelated typed data, capabilities and object navigation without session IDs", async () => {
  const f = fixture();
  const stop = await f.binding.mount(f.element, f.environment, f.failed);
  const context = f.mount.mock.lastCall?.[1];
  if (!context) throw new Error("missing mount");
  expect(f.stop).not.toHaveBeenCalled();
  expect(context.classId).toBe("class:library");
  expect(context.locale).toBe("eu");
  expect(context.settings).toEqual({ units: "books" });
  expect(context.placement).toEqual({ slot: "aside", size: "compact" });
  expect(context.capabilities).toEqual({ canRead: true });
  expect(context.message("library")).toBe("library");
  expect(await context.data.read(context.signal)).toEqual({ titles: ["Synthetic book"] });
  const request = new AbortController();
  const remove = vi.spyOn(request.signal, "removeEventListener");
  expect(await context.navigation.navigate({ shelf: 3 }, request.signal)).toBe(true);
  expect(remove).toHaveBeenCalledOnce();
  expect(f.navigate).toHaveBeenCalledWith({ shelf: 3 }, expect.any(AbortSignal));
  const receive = vi.fn();
  const sub = new AbortController();
  const unsubscribe = context.data.subscribe?.(sub.signal, receive);
  f.receive(["First"]);
  expect(receive).toHaveBeenCalledWith({ titles: ["First"] });
  sub.abort();
  f.receive(["Late"]);
  expect(receive).toHaveBeenCalledOnce();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  unsubscribe?.();
  f.receive(["Stopped"]);
  expect(receive).toHaveBeenCalledOnce();
  stop();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(context.signal.aborted).toBe(true);
  await expect(
    context.navigation.navigate({ shelf: 4 }, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.navigate).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
});
it("rejects late navigation and reads even if adapters ignore cancellation", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<boolean>();
  f.navigate.mockReturnValue(pending.promise);
  await f.binding.mount(f.element, f.environment, f.failed);
  const context = f.mount.mock.lastCall?.[1];
  if (!context) throw new Error("missing mount");
  const navigation = context.navigation.navigate({ shelf: 1 }, context.signal);
  f.abort.abort();
  expect(f.navigate.mock.lastCall?.[1].aborted).toBe(true);
  pending.resolve(true);
  await expect(navigation).rejects.toThrow();
});
it("preserves absent subscriptions and false navigation, and cancels before invoking navigation", async () => {
  const f = fixture();
  f.navigate.mockResolvedValue(false);
  const binding = bindDashboardModule(
    () => Promise.resolve({ default: { mount: f.mount } }),
    () => ({ ...f.source, data: { read: f.read } }),
  );
  await binding.mount(f.element, f.environment, f.failed);
  const context = f.mount.mock.lastCall?.[1];
  if (!context) throw new Error("missing mount");
  expect(context.data.subscribe).toBeUndefined();
  expect(context.data).not.toHaveProperty("subscribe");
  expect(await context.navigation.navigate({ shelf: 0 }, context.signal)).toBe(false);
  const cancelled = AbortSignal.abort();
  await expect(context.navigation.navigate({ shelf: 0 }, cancelled)).rejects.toThrow();
  expect(f.navigate).toHaveBeenCalledOnce();
  const failedRequest = new AbortController();
  const remove = vi.spyOn(failedRequest.signal, "removeEventListener");
  f.navigate.mockRejectedValueOnce(new Error("navigation failed"));
  await expect(context.navigation.navigate({ shelf: 1 }, failedRequest.signal)).rejects.toThrow(
    "navigation failed",
  );
  expect(remove).toHaveBeenCalledOnce();
  f.abort.abort();
});
it("disposes a module aborting synchronously inside mount", async () => {
  const f = fixture();
  f.mount.mockImplementation(() => {
    f.abort.abort();
    return f.stop;
  });
  const stop = await f.binding.mount(f.element, f.environment, f.failed);
  expect(f.stop).toHaveBeenCalledOnce();
  stop();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("cleans a subscription whose adapter aborts synchronously before returning cleanup", async () => {
  const f = fixture();
  const sub = new AbortController();
  const binding = bindDashboardModule(
    () => Promise.resolve({ default: { mount: f.mount } }),
    () => ({
      ...f.source,
      data: {
        ...f.source.data,
        subscribe() {
          sub.abort();
          return f.unsubscribe;
        },
      },
    }),
  );
  const stop = await binding.mount(f.element, f.environment, f.failed);
  const context = f.mount.mock.lastCall?.[1];
  context?.data.subscribe?.(sub.signal, vi.fn());
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  stop();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});
it("suppresses callbacks after manual unsubscribe even from a broken transport", async () => {
  const f = fixture();
  const stop = await f.binding.mount(f.element, f.environment, f.failed);
  const context = f.mount.mock.lastCall?.[1];
  const receive = vi.fn();
  const unsubscribe = context?.data.subscribe?.(new AbortController().signal, receive);
  unsubscribe?.();
  f.receive(["Stopped"]);
  expect(receive).not.toHaveBeenCalled();
  stop();
});
it("keeps the host environment authoritative over adapter context", async () => {
  const f = fixture();
  const binding = bindDashboardModule(
    () => Promise.resolve({ default: { mount: f.mount } }),
    () => ({ ...f.source, classId: "wrong", signal: AbortSignal.abort() }),
  );
  const stop = await binding.mount(f.element, f.environment, f.failed);
  expect(f.mount.mock.lastCall?.[1].classId).toBe(f.environment.classId);
  expect(f.mount.mock.lastCall?.[1].signal.aborted).toBe(false);
  stop();
});

it("removes its subscription abort listener when manually disposed", async () => {
  const f = fixture();
  const binding = bindDashboardModule(
    () => Promise.resolve({ default: { mount: f.mount } }),
    () => ({
      ...f.source,
      data: {
        ...f.source.data,
        subscribe(signal: AbortSignal) {
          const remove = vi.spyOn(signal, "removeEventListener");
          const add = vi.spyOn(signal, "addEventListener");
          return () => {
            expect(add).toHaveBeenCalledWith("abort", expect.any(Function));
            expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
            f.unsubscribe();
          };
        },
      },
    }),
  );
  const stop = await binding.mount(f.element, f.environment, f.failed);
  const unsubscribe = f.mount.mock.lastCall?.[1].data.subscribe?.(
    new AbortController().signal,
    vi.fn(),
  );
  unsubscribe?.();
  stop();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});
