import { expect, it, vi } from "vitest";
import {
  createDashboardHostViewEntries,
  mountDashboardHostView,
  type DashboardHostView,
} from "./browser.js";

function fixture() {
  const abort = new AbortController();
  const stop = vi.fn();
  const render = vi.fn<DashboardHostView>().mockReturnValue(stop);
  const pending = Promise.withResolvers<DashboardHostView>();
  const read = vi.fn().mockReturnValue(pending.promise);
  const replaceChildren = vi.fn();
  const element = { textContent: "", replaceChildren } as Partial<HTMLElement> as HTMLElement;
  const mount = () =>
    mountDashboardHostView(element, {
      signal: abort.signal,
      data: { read },
      message: (key) => `message:${key}`,
    });
  return { abort, stop, render, pending, read, replaceChildren, element, mount };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("renders the resolved host view with the lifetime signal and disposes it once", async () => {
  const f = fixture();
  const dispose = f.mount();
  expect(f.read).toHaveBeenCalledExactlyOnceWith(f.abort.signal);
  expect(f.render).not.toHaveBeenCalled();
  f.pending.resolve(f.render);
  await settle();
  expect(f.render).toHaveBeenCalledExactlyOnceWith(f.element);
  dispose();
  dispose();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.replaceChildren).not.toHaveBeenCalled();
});

it("clears an unrendered element once and never renders after disposal or abort", async () => {
  for (const cancel of ["dispose", "abort"] as const)
    for (const outcome of ["resolve", "reject"] as const) {
      const f = fixture();
      const dispose = f.mount();
      if (cancel === "dispose") dispose();
      else f.abort.abort();
      if (outcome === "resolve") f.pending.resolve(f.render);
      else f.pending.reject(new Error("private detail"));
      await settle();
      expect(f.render).not.toHaveBeenCalled();
      expect(f.element.textContent).toBe("");
      dispose();
      dispose();
      expect(f.replaceChildren).toHaveBeenCalledOnce();
    }
});

it("shows only the localized failure message when the read fails", async () => {
  const f = fixture();
  const dispose = f.mount();
  f.pending.reject(new Error("private detail"));
  await settle();
  expect(f.element.textContent).toBe("message:failed");
  dispose();
  expect(f.replaceChildren).toHaveBeenCalledOnce();
});

it("creates both browser contracts around the same host view mount", async () => {
  const { entry, typedEntry } = createDashboardHostViewEntries<{ readonly viewRead: true }>();
  expect(typedEntry.mount).toBe(mountDashboardHostView);
  const f = fixture();
  const dispose = entry.mount(f.element, {
    settings: {},
    placement: { slot: "aside", size: "standard" },
    classId: "class:a",
    locale: "eu",
    timeRange: { from: "", to: "" },
    signal: f.abort.signal,
    ports: {
      read: f.read,
      message: (key) => `port:${key}`,
      navigate: () => Promise.resolve(false),
    },
  });
  expect(f.read).toHaveBeenCalledExactlyOnceWith(f.abort.signal);
  f.pending.reject(new Error("private detail"));
  await settle();
  expect(f.element.textContent).toBe("port:failed");
  dispose();
  expect(f.replaceChildren).toHaveBeenCalledOnce();
});

it("shows the localized failure when the host view throws while rendering", async () => {
  const f = fixture();
  const dispose = f.mount();
  f.render.mockImplementation(() => {
    throw new Error("render failed");
  });
  f.pending.resolve(f.render);
  await settle();
  expect(f.render).toHaveBeenCalledOnce();
  expect(f.element.textContent).toBe("message:failed");
  dispose();
  dispose();
  expect(f.replaceChildren).toHaveBeenCalledOnce();
  expect(f.stop).not.toHaveBeenCalled();
});
