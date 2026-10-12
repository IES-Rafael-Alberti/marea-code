import { expect, it, vi } from "vitest";
import type { SqliteRow } from "./contracts.js";
import { createDashboardLanguageStore } from "./dashboard-language-store.js";
it("uses an exact account key, persists changes and refuses corrupt storage", () => {
  const readOne = vi.fn<() => SqliteRow | undefined>(),
    execute = vi.fn();
  const store = createDashboardLanguageStore({
    readOne,
    execute,
  });
  expect(store.read("user:one")).toBeNull();
  expect(readOne).toHaveBeenLastCalledWith("SELECT value FROM marea_metadata WHERE key = ?1", [
    "dashboard-language:user:one",
  ]);
  readOne.mockReturnValue({ value: "eu" });
  expect(store.read("user:two")).toBe("eu");
  expect(readOne.mock.calls.at(-1)).toEqual([
    "SELECT value FROM marea_metadata WHERE key = ?1",
    ["dashboard-language:user:two"],
  ]);
  store.write("user:one", "es");
  expect(execute).toHaveBeenCalledWith(
    "INSERT INTO marea_metadata(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ["dashboard-language:user:one", "es"],
  );
  readOne.mockReturnValue({ value: 4 });
  expect(() => store.read("user:one")).toThrow("Invalid dashboard language record.");
});
