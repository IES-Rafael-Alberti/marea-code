import { afterEach, expect, it, vi } from "vitest";
import {
  moduleSection,
  rememberNavigation,
  rememberedNavigation,
  settingsSection,
  workspaceSection,
} from "./workspace-navigation.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("places each module in its view and falls back to defaults for unknown navigation", () => {
  expect(
    [
      "org.marea.module.sessions",
      "org.marea.module.map",
      "org.marea.module.progress",
      "org.marea.module.reports",
      "org.marea.module.reviewed-evidence",
      "org.marea.module.usage",
    ].map(moduleSection),
  ).toEqual(["sessions", "map", "progress", "reports", "progress", "settings"]);
  expect([workspaceSection("reports"), workspaceSection("other"), workspaceSection(null)]).toEqual([
    "reports",
    "sessions",
    "sessions",
  ]);
  expect([settingsSection("server"), settingsSection("other")]).toEqual(["server", "classroom"]);
});

it("reads and replaces navigation parameters, starting from defaults without a location", () => {
  expect(rememberedNavigation("view")).toBeNull();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { href: "http://localhost/dashboard/?view=map&keep=1" },
    history: { state: { kept: true }, replaceState },
  });
  expect(rememberedNavigation("view")).toBe("map");
  rememberNavigation({ view: "settings", settings: "server" });
  expect(replaceState).toHaveBeenCalledWith(
    { kept: true },
    "",
    new URL("http://localhost/dashboard/?view=settings&keep=1&settings=server"),
  );
});
