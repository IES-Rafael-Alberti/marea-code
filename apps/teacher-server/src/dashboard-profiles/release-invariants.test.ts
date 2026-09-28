import { expect, it } from "vitest";
import * as z from "zod";
import { createDashboardModuleSelectionSchema } from "@marea/protocol";
import { release, selected } from "./release.fixture.js";
import { validateDashboardProfileRelease } from "./release.js";

it("validates injected selection schemas against descriptor identity, version and placement", () => {
  const placements = (["main", "aside"] as const).flatMap((slot) =>
    (["compact", "standard", "wide"] as const).map((size) => ({ slot, size })),
  );
  const first = createDashboardModuleSelectionSchema(
    selected.moduleId,
    1,
    z.strictObject({ limit: z.number() }),
    placements,
  );
  const second = createDashboardModuleSelectionSchema(
    "org.marea.second-module",
    1,
    z.strictObject({ limit: z.number() }),
    placements,
  );
  const selection = z.union([first, second]);
  const module = release.modules[0];
  const validated = validateDashboardProfileRelease({
    ...release,
    selection,
    modules: [
      {
        ...module,
        supportedPlacements: [
          { slot: "main", size: "standard" },
          { slot: "aside", size: "wide" },
        ],
      },
      { ...module, id: "org.marea.other-module" },
    ],
    themes: [...release.themes, { ...release.themes[0], id: "org.marea.second-theme" }],
  });
  expect(validated.selection.parse(selected)).toEqual(selected);
  expect(
    validated.schemas.personalValue.parse({ themeId: "org.marea.second-theme", modules: [] }),
  ).toEqual({ themeId: "org.marea.second-theme", modules: [] });
  expect(
    validated.schemas.personalValue.safeParse({ themeId: "org.marea.missing", modules: [] })
      .success,
  ).toBe(false);
  for (const change of [
    { moduleId: "org.marea.second-module" },
    { placement: { slot: "main", size: "wide" } },
    { placement: { slot: "aside", size: "standard" } },
  ])
    expect(validated.selection.safeParse({ ...selected, ...change }).success).toBe(false);
  const wrongVersion = validateDashboardProfileRelease({
    ...release,
    selection,
    modules: [{ ...module, configurationVersion: 2 }],
    defaults: { ...release.defaults, modules: [] },
  });
  expect(wrongVersion.selection.safeParse(selected).success).toBe(false);
  const missingDefault = validateDashboardProfileRelease({
    ...release,
    selection,
    defaults: {
      ...release.defaults,
      modules: [{ ...selected, moduleId: "org.marea.second-module" }],
    },
  });
  expect(missingDefault.defaults.modules).toEqual([]);
});
it("requires every capability and removes optional themes with unavailable dependencies", () => {
  const modules = [
    { ...release.modules[0], requiredServerCapabilities: ["sessions/v1", "health/v1"] },
  ];
  expect(validateDashboardProfileRelease({ ...release, modules }).modules).toEqual([]);
  const themes = [
    ...release.themes,
    { ...release.themes[0], id: "org.marea.optional", requiredDependencies: ["org.marea.missing"] },
  ];
  expect(validateDashboardProfileRelease({ ...release, themes }).themes).toEqual(release.themes);
});
it("bounds original release counts with actionable diagnostics, including exact maxima", () => {
  const modules = Array.from({ length: 64 }, (_, i) => ({
    ...release.modules[0],
    id: `org.marea.module-${String(i)}`,
  }));
  const themes = Array.from({ length: 15 }, (_, i) => ({
    ...release.themes[0],
    id: `org.marea.theme-${String(i)}`,
  }));
  const maximal = {
    ...release,
    modules,
    themes: [...release.themes, ...themes],
    defaults: { ...release.defaults, modules: [] },
  };
  expect(validateDashboardProfileRelease(maximal).themes).toHaveLength(16);
  for (const change of [
    { modules: [...modules, { ...release.modules[0], id: "org.marea.extra" }] },
    { themes: [...maximal.themes, { ...release.themes[0], id: "org.marea.extra" }] },
  ])
    expect(() => validateDashboardProfileRelease({ ...maximal, ...change })).toThrow(
      "Dashboard plugin catalog: descriptor count exceeds limit. Rebuild or enable compatible release artifacts.",
    );
  expect(() =>
    validateDashboardProfileRelease({
      ...release,
      modules: [...release.modules, ...release.modules],
    }),
  ).toThrow(
    "Dashboard plugin catalog: duplicate IDs. Rebuild or enable compatible release artifacts.",
  );
});
it("handles a shared dependency DAG within the bounded release catalog", () => {
  const modules = Array.from({ length: 48 }, (_, i) => ({
    ...release.modules[0],
    id: `org.marea.module-${String(i)}`,
    requiredDependencies: [i - 1, i - 2]
      .filter((n) => n >= 0)
      .map((n) => `org.marea.module-${String(n)}`),
  }));
  expect(
    validateDashboardProfileRelease({
      ...release,
      modules,
      defaults: { ...release.defaults, modules: [] },
    }).modules,
  ).toHaveLength(48);
});
