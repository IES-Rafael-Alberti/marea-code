import { expect, it, vi } from "vitest";
vi.mock("@marea/plugin-runtime/browser", async (original) => ({
  ...(await original<typeof import("@marea/plugin-runtime/browser")>()),
  dashboardModuleDescriptorLoaders: {},
}));
import { loadProfileCatalog } from "./profile-catalog.js";
it("uses the shared never-selection schema when the release contains no modules", async () => {
  const catalog = await loadProfileCatalog();
  expect(
    catalog.schemas.personalValue.parse({ themeId: "org.marea.theme.marea", modules: [] }),
  ).toEqual({ themeId: "org.marea.theme.marea", modules: [] });
  expect(
    catalog.schemas.personalValue.safeParse({
      themeId: "org.marea.theme.marea",
      modules: [
        {
          moduleId: "org.marea.module.sessions",
          enabled: true,
          configurationVersion: 1,
          settings: {},
          placement: { slot: "main", size: "wide" },
        },
      ],
    }).success,
  ).toBe(false);
});
