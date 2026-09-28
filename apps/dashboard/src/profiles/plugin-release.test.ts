import { expect, it, vi } from "vitest";
import {
  dashboardModuleLoaders,
  dashboardModuleDescriptorLoaders,
} from "@marea/plugin-runtime/browser";
import type { DashboardModuleContext } from "@marea/plugin-api/browser";
import { selection } from "./profile.fixture.js";
import descriptor from "../../../../plugins/dashboard-modules/sessions/src/index.js";
import entry, { typedEntry } from "../../../../plugins/dashboard-modules/sessions/src/browser.js";
type View = (element: HTMLElement) => () => void;
function fixture(classId: string | null = "class:a") {
  const abort = new AbortController();
  const stop = vi.fn();
  const render = vi.fn<View>().mockReturnValue(stop);
  const read = vi.fn().mockResolvedValue(render);
  const replaceChildren = vi.fn();
  const element = { textContent: "", replaceChildren } as Partial<HTMLElement> as HTMLElement;
  const context: DashboardModuleContext<object, View> = {
    settings: {},
    placement: selection.placement,
    classId,
    locale: "en",
    timeRange: { from: "", to: "" },
    signal: abort.signal,
    ports: { read, message: (key) => key, navigate: () => Promise.resolve(false) },
  };
  return { abort, context, element, render, read, stop, replaceChildren };
}
it("ships strict pure settings and never reads data without a selected class", async () => {
  vi.resetModules();
  const installed = (await dashboardModuleDescriptorLoaders[selection.moduleId]()).default;
  expect(descriptor.manifest).toEqual(installed.manifest);
  expect(descriptor.defaultSettings).toEqual({});
  expect(descriptor.settingsSchema.parse({})).toEqual({});
  expect(descriptor.settingsSchema.safeParse({ extra: true }).success).toBe(false);
  expect((await dashboardModuleLoaders[selection.moduleId]()).default.mount).toBeTypeOf("function");
  const f = fixture(null);
  const stop = entry.mount(f.element, f.context);
  expect(f.element.textContent).toBe("selectClass");
  expect(f.read).not.toHaveBeenCalled();
  stop();
  expect(f.replaceChildren).toHaveBeenCalledOnce();
  stop();
  expect(f.replaceChildren).toHaveBeenCalledOnce();
});
it("mounts the public session renderer and disposes it", async () => {
  const f = fixture();
  const stop = entry.mount(f.element, f.context);
  expect(f.element.textContent).toBe("loading");
  await vi.waitFor(() => {
    expect(f.render).toHaveBeenCalledWith(f.element);
  });
  stop();
  expect(f.stop).toHaveBeenCalledOnce();
  stop();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.replaceChildren).not.toHaveBeenCalled();
});
it.each([false, true])("isolates failures and late completions (abort=%s)", async (abort) => {
  for (const dispose of [false, true])
    for (const reject of [false, true]) {
      const f = fixture();
      const pending = Promise.withResolvers<View>();
      f.read.mockReturnValue(pending.promise);
      const stop = entry.mount(f.element, f.context);
      if (abort) f.abort.abort();
      if (dispose) stop();
      if (reject) pending.reject(new Error("failed"));
      else pending.resolve(f.render);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.render).toHaveBeenCalledTimes(abort || dispose || reject ? 0 : 1);
      expect(f.element.textContent).toBe(!abort && !dispose && reject ? "failed" : "loading");
      stop();
    }
  const f = fixture();
  f.render.mockImplementation(() => {
    throw new Error("render failed");
  });
  entry.mount(f.element, f.context);
  await vi.waitFor(() => {
    expect(f.element.textContent).toBe("failed");
  });
});
it("constructs the installed typed selection union when called by the browser", async () => {
  const { loadProfileCatalog } = await import("./profile-catalog.js");
  const release = await loadProfileCatalog();
  expect(
    release.schemas.personalValue.parse({ themeId: "org.marea.theme.marea", modules: [selection] }),
  ).toEqual({ themeId: "org.marea.theme.marea", modules: [selection] });
  expect(
    release.schemas.personalValue.safeParse({ themeId: "org.marea.missing", modules: [] }).success,
  ).toBe(false);
});

it("adapts the additive typed session entry while keeping the default contract", async () => {
  const f = fixture();
  const original = entry.mount;
  let navigation: Promise<boolean> | undefined;
  const bridge = vi.spyOn(entry, "mount").mockImplementation((element, context) => {
    navigation = context.ports.navigate("sessions");
    return original(element, context);
  });
  const stop = typedEntry.mount(f.element, {
    ...f.context,
    data: f.context.ports,
    capabilities: { sessionReview: true },
    navigation: { navigate: () => Promise.resolve(false) },
    message: (key) => key,
  });
  await expect(navigation).resolves.toBe(false);
  await vi.waitFor(() => {
    expect(f.render).toHaveBeenCalledOnce();
  });
  stop();
  expect(f.stop).toHaveBeenCalledOnce();
  bridge.mockRestore();
});
