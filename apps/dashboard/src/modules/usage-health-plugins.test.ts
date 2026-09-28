import { expect, it, vi } from "vitest";
import { mountDashboardHostView, type DashboardHostView } from "@marea/plugin-api/browser";
import {
  dashboardModuleDescriptorLoaders,
  dashboardModuleLoaders,
} from "@marea/plugin-runtime/browser";

// Optional plugins: each case runs only while its plugin is in the generated catalog.
const installed = (id: string) => ({
  descriptor: Object.entries(dashboardModuleDescriptorLoaders).find(([key]) => key === id)?.[1],
  browser: Object.entries(dashboardModuleLoaders).find(([key]) => key === id)?.[1],
});
const plugins = [
  ["org.marea.module.usage", "usage"],
  ["org.marea.module.health", "health"],
  ["org.marea.module.reviewed-evidence", "reviewed-evidence"],
] as const;

it.each(plugins)(
  "%s ships a strict pure descriptor requiring its own capability and permission",
  async (id, name) => {
    const { descriptor } = installed(id);
    if (descriptor === undefined) return;
    const { default: entry, settingsSchema } = await descriptor();
    expect(entry.manifest).toMatchObject({
      id,
      requiredServerCapabilities: [`${name}/v1`],
      requiredPermissions: [
        "class-read",
        name === "reviewed-evidence" ? "evaluation-read" : `${name}-read`,
      ],
      freshness: { kind: "on-demand" },
      defaultPlacement: { slot: "aside", size: "standard" },
    });
    expect(settingsSchema.safeParse({ extra: true }).success).toBe(false);
    expect(entry.defaultSettings).toEqual({});
    if (name === "reviewed-evidence") expect(entry.manifest.defaultEnabled).toBe(false);
  },
);

it.each(plugins)("%s mounts the host view through both browser contracts", async (id) => {
  const { browser } = installed(id);
  if (browser === undefined) return;
  const module = await browser();
  expect(module.typedEntry.mount).toBe(mountDashboardHostView);
  const render = vi.fn<DashboardHostView>().mockReturnValue(vi.fn());
  const read = vi.fn().mockResolvedValue(render);
  const element = {
    textContent: "",
    replaceChildren: vi.fn(),
  } as Partial<HTMLElement> as HTMLElement;
  const signal = new AbortController().signal;
  const dispose = module.default.mount(element, {
    settings: {},
    placement: { slot: "aside", size: "standard" },
    classId: "class:a",
    locale: "en",
    timeRange: { from: "", to: "" },
    signal,
    ports: { read, message: (key) => `m:${key}`, navigate: () => Promise.resolve(false) },
  });
  expect(read).toHaveBeenCalledExactlyOnceWith(signal);
  await vi.waitFor(() => {
    expect(render).toHaveBeenCalledWith(element);
  });
  dispose();
});
