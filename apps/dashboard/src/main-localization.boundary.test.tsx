import { afterEach, expect, it, vi } from "vitest";

import { startDashboard } from "./start-dashboard.js";

vi.mock("./start-dashboard.js", () => ({ startDashboard: vi.fn() }));
vi.mock("./modules/teaching/teaching-client.boundary.js", () => ({ localTeachingClient: {} }));
vi.mock("./modules/governance/governance-client.boundary.js", () => ({
  createGovernanceClient: vi.fn(),
}));
vi.mock("./modules/usage-health-adapters.js", () => ({ createUsageHealthAdapters: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([false, true])("starts with browser storage blocked=%s", async (blocked) => {
  vi.resetModules();
  const document = { documentElement: { lang: "" } };
  const storage = { getItem: vi.fn(() => "eu"), setItem: vi.fn() };
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { language: "es-ES", languages: ["eu-ES", "es-ES"] });
  vi.stubGlobal("localStorage", storage);
  if (blocked) {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Storage access denied");
      },
    });
  }

  await import("./main.js");

  expect(startDashboard).toHaveBeenCalledOnce();
  const browser = vi.mocked(startDashboard).mock.calls[0]?.[0];
  expect(browser?.document).toBe(document);
  expect(browser?.language).toBe("es-ES");
  expect(browser?.languages).toEqual(["eu-ES", "es-ES"]);
  expect(browser?.storage).toBe(blocked ? undefined : storage);
});
