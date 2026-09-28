import { expect, it, vi } from "vitest";
import type {
  DashboardModuleBrowserEntry,
  DashboardModuleContext,
} from "@marea/plugin-api/browser";
import { mountDashboardModule } from "./module-host.js";
function setup() {
  const abort = new AbortController();
  const element = {} as HTMLElement;
  const read = vi.fn().mockResolvedValue("data");
  const unsubscribe = vi.fn();
  let receive: (data: string) => void = () => undefined;
  const context: DashboardModuleContext<object, string> = {
    settings: {},
    placement: { slot: "main", size: "wide" },
    classId: "class:a",
    locale: "en",
    timeRange: { from: "", to: "" },
    signal: abort.signal,
    ports: {
      read,
      message: (key) => key,
      navigate: () => Promise.resolve(true),
      subscribe: (_signal, callback) => {
        receive = callback;
        return unsubscribe;
      },
    },
  };
  const dispose = vi.fn();
  const mount = vi
    .fn<DashboardModuleBrowserEntry<object, string>["mount"]>()
    .mockReturnValue(dispose);
  const load = vi.fn().mockResolvedValue({ default: { mount } });
  const failed = vi.fn();
  return {
    abort,
    context,
    element,
    read,
    unsubscribe,
    receive: (data: string) => {
      receive(data);
    },
    dispose,
    mount,
    load,
    failed,
  };
}
it("cancels public reads, subscriptions and rendering before class/disable/signout disposal", async () => {
  const f = setup();
  const stop = await mountDashboardModule(f.element, f.load, f.context, f.failed);
  const context = f.mount.mock.calls[0]?.[1];
  if (context === undefined) throw new Error("no mount");
  expect(await context.ports.read(context.signal)).toBe("data");
  const receive = vi.fn();
  const unsubscribe = context.ports.subscribe?.(context.signal, receive);
  f.receive("first");
  expect(receive).toHaveBeenCalledWith("first");
  unsubscribe?.();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  context.ports.subscribe?.(context.signal, receive);
  f.abort.abort();
  f.receive("late");
  expect(receive).toHaveBeenCalledTimes(1);
  expect(f.unsubscribe).toHaveBeenCalledTimes(2);
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(context.signal.aborted).toBe(true);
  await expect(context.ports.read(context.signal)).rejects.toThrow();
  expect(() => context.ports.subscribe?.(context.signal, receive)).toThrow();
  stop();
  expect(f.dispose).toHaveBeenCalledOnce();
});
it("rejects late reads even from a transport ignoring cancellation", async () => {
  const f = setup();
  const pending = Promise.withResolvers<string>();
  f.read.mockReturnValue(pending.promise);
  const stop = await mountDashboardModule(f.element, f.load, f.context, f.failed);
  const context = f.mount.mock.calls[0]?.[1];
  if (context === undefined) throw new Error("no mount");
  const read = context.ports.read(context.signal);
  stop();
  pending.resolve("other class");
  await expect(read).rejects.toThrow();
});
it("isolates load and render failures, absent subscriptions and aborted imports", async () => {
  for (const renderFailure of [false, true]) {
    const f = setup();
    if (renderFailure)
      f.mount.mockImplementation(() => {
        throw new Error("render");
      });
    else f.load.mockRejectedValue(new Error("load"));
    await mountDashboardModule(f.element, f.load, f.context, f.failed);
    expect(f.failed).toHaveBeenCalledOnce();
  }
  const f = setup();
  const ports = {
    read: f.context.ports.read,
    message: f.context.ports.message,
    navigate: f.context.ports.navigate,
  };
  await mountDashboardModule(f.element, f.load, { ...f.context, ports }, f.failed);
  expect(f.mount.mock.calls[0]?.[1].ports.subscribe).toBeUndefined();
  const pending = Promise.withResolvers<{ default: DashboardModuleBrowserEntry<object, string> }>();
  f.load.mockReturnValue(pending.promise);
  const mounting = mountDashboardModule(f.element, f.load, f.context, f.failed);
  f.abort.abort();
  pending.resolve({ default: { mount: f.mount } });
  await mounting;
  expect(f.mount).toHaveBeenCalledTimes(1);
  await mountDashboardModule(f.element, f.load, f.context, f.failed);
  expect(f.load).toHaveBeenCalledTimes(2);
  const late = setup();
  const rejected = Promise.withResolvers<{
    default: DashboardModuleBrowserEntry<object, string>;
  }>();
  late.load.mockReturnValue(rejected.promise);
  const loading = mountDashboardModule(late.element, late.load, late.context, late.failed);
  late.abort.abort();
  rejected.reject(new Error("late"));
  await loading;
  expect(late.failed).not.toHaveBeenCalled();
});
it("removes lifetime listeners, clears subscriptions and checks cancellation before calling ports", async () => {
  const f = setup();
  const add = vi.spyOn(f.abort.signal, "addEventListener");
  const remove = vi.spyOn(f.abort.signal, "removeEventListener");
  const stop = await mountDashboardModule(f.element, f.load, f.context, f.failed);
  expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
  const context = f.mount.mock.lastCall?.[1];
  if (context === undefined) throw new Error("missing context");
  context.ports.subscribe?.(context.signal, vi.fn());
  stop();
  stop();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  await expect(context.ports.read(context.signal)).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  const early = setup();
  early.abort.abort();
  const removeEarly = vi.spyOn(early.abort.signal, "removeEventListener");
  await mountDashboardModule(early.element, early.load, early.context, early.failed);
  expect(removeEarly).toHaveBeenCalled();
  const broken = setup();
  let captured: AbortSignal | undefined;
  broken.mount.mockImplementation((_element, ctx) => {
    captured = ctx.signal;
    ctx.ports.subscribe?.(ctx.signal, vi.fn());
    throw new Error("render");
  });
  await mountDashboardModule(broken.element, broken.load, broken.context, broken.failed);
  expect(captured?.aborted).toBe(true);
  expect(broken.unsubscribe).toHaveBeenCalledOnce();
});
it("unregisters a manually stopped subscription from later host disposal", async () => {
  const f = setup();
  const stop = await mountDashboardModule(f.element, f.load, f.context, f.failed);
  const context = f.mount.mock.lastCall?.[1];
  if (context === undefined) throw new Error("missing context");
  const unsubscribe = context.ports.subscribe?.(context.signal, vi.fn());
  unsubscribe?.();
  stop();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});
