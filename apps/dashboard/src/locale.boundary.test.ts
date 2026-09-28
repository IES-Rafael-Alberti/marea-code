import { describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_LOCALE_STORAGE_KEY,
  readDashboardPreference,
  writeDashboardPreference,
} from "./locale.boundary.js";

describe("dashboard interface preference storage", () => {
  it("validates the namespaced versioned preference and ignores corrupt storage", () => {
    const storage = { getItem: vi.fn(() => "eu"), setItem: vi.fn() };
    expect(readDashboardPreference(storage)).toBe("eu");
    expect(storage.getItem).toHaveBeenCalledWith(DASHBOARD_LOCALE_STORAGE_KEY);
    expect(readDashboardPreference({ getItem: () => "fr", setItem: vi.fn() })).toBeNull();
    expect(readDashboardPreference({ getItem: () => "{broken", setItem: vi.fn() })).toBeNull();
  });

  it("does not block a language change when storage access fails", () => {
    expect(readDashboardPreference(undefined)).toBeNull();
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDashboardPreference(storage)).toBeNull();
    expect(writeDashboardPreference(storage, "en")).toBe(false);
    expect(writeDashboardPreference(undefined, "en")).toBe(false);
  });

  it("keeps the in-memory change available when only writes fail", () => {
    expect(
      writeDashboardPreference(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("blocked");
          },
        },
        "eu",
      ),
    ).toBe(false);
  });

  it("writes only the validated preference value", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    expect(writeDashboardPreference(storage, "automatic")).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(DASHBOARD_LOCALE_STORAGE_KEY, "automatic");
  });
});
