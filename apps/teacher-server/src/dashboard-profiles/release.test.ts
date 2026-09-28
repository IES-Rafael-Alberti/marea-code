import { expect, it } from "vitest";
import { release } from "./profile.fixture.js";
import {
  DashboardReleaseError,
  validateDashboardProfileRelease,
  type DashboardReleaseReason,
} from "./release.js";
it("validates defaults, descriptor bounds and duplicate identity", () => {
  expect(validateDashboardProfileRelease(release).defaults).toEqual(release.defaults);
  for (const changed of [
    { revision: "invalid" },
    { themes: [] },
    { modules: [...release.modules, ...release.modules] },
    { defaults: { ...release.defaults, themeId: "org.marea.missing" } },
    {
      modules: Array.from({ length: 65 }, (_, i) => ({
        ...release.modules[0],
        id: `org.marea.module-${String(i)}`,
      })),
    },
    {
      themes: Array.from({ length: 17 }, (_, i) => ({
        ...release.themes[0],
        id: `org.marea.theme-${String(i)}`,
      })),
    },
  ])
    expect(() => validateDashboardProfileRelease({ ...release, ...changed })).toThrow();
});
it("fails required dependencies and cycles with private actionable diagnostics", () => {
  const module = release.modules[0];
  expect(() =>
    validateDashboardProfileRelease({ ...release, requiredIds: [module.id], capabilities: [] }),
  ).toThrow("Rebuild");
  expect(() =>
    validateDashboardProfileRelease({
      ...release,
      modules: [{ ...module, requiredDependencies: [release.defaults.themeId] }],
      themes: release.themes.map((theme) => ({ ...theme, requiredDependencies: [module.id] })),
    }),
  ).toThrow("cycle");
  expect(() =>
    validateDashboardProfileRelease({
      ...release,
      modules: [{ ...module, conflicts: [release.defaults.themeId] }],
    }),
  ).toThrow("conflicting");
  expect(() =>
    validateDashboardProfileRelease({
      ...release,
      requiredIds: [module.id],
      modules: [{ ...module, requiredDependencies: ["org.marea.missing"] }],
    }),
  ).toThrow("required dependency");
});
it("disables optional modules with missing capabilities or dependencies", () => {
  const defaults = { ...release.defaults, modules: [] };
  expect(
    validateDashboardProfileRelease({ ...release, defaults, capabilities: [] }).modules,
  ).toEqual([]);
  expect(
    validateDashboardProfileRelease({
      ...release,
      defaults,
      modules: release.modules.map((module) => ({
        ...module,
        requiredDependencies: ["org.marea.missing"],
      })),
    }).modules,
  ).toEqual([]);
});
it("rejects a complete catalog larger than the response byte budget", () => {
  const optionalDependencies = Array.from(
    { length: 32 },
    (_, i) => `org.${"x".repeat(145)}.dep-${String(i)}`,
  );
  const modules = Array.from({ length: 64 }, (_, i) => ({
    ...release.modules[0],
    id: `org.marea.module-${String(i)}`,
    optionalDependencies,
  }));
  expect(() =>
    validateDashboardProfileRelease({
      ...release,
      modules,
      defaults: { ...release.defaults, modules: [] },
    }),
  ).toThrow("response exceeds");
});
it("traverses shared dependencies once and handles optional dependency cycles", () => {
  expect(
    validateDashboardProfileRelease({
      ...release,
      modules: [{ ...release.modules[0], requiredDependencies: [release.defaults.themeId] }],
    }).modules,
  ).toHaveLength(1);
  expect(() =>
    validateDashboardProfileRelease({
      ...release,
      modules: [{ ...release.modules[0], optionalDependencies: [release.defaults.themeId] }],
      themes: [{ ...release.themes[0], optionalDependencies: [release.modules[0].id] }],
    }),
  ).toThrow("cycle");
});
it("isolates invalid optional descriptors but rejects required artifacts", () => {
  const module = { ...release.modules[0] };
  Reflect.set(module, "apiVersion", "1.0");
  expect(validateDashboardProfileRelease({ ...release, modules: [module] }).modules).toEqual([]);
  expect(() =>
    validateDashboardProfileRelease({ ...release, modules: [module], requiredIds: [module.id] }),
  ).toThrow(module.id);
  const theme = { ...release.themes[0] };
  Reflect.set(theme, "tokens", {});
  expect(() => validateDashboardProfileRelease({ ...release, themes: [theme] })).toThrow(theme.id);
  expect(
    validateDashboardProfileRelease({
      ...release,
      themes: [...release.themes, { ...theme, id: "org.marea.invalid-optional" }],
    }).themes,
  ).toHaveLength(1);
});
it("preserves validated descriptor identities, normalized defaults and revision", () => {
  const validated = validateDashboardProfileRelease(release);
  expect(validated.modules).toEqual(release.modules);
  expect(validated.themes).toEqual(release.themes);
  expect(validated.revision).toBe(release.revision);
  expect(validated.defaults).toEqual(release.defaults);
  expect(() =>
    validateDashboardProfileRelease({ ...release, requiredIds: ["org.marea.absent"] }),
  ).toThrow(
    "Dashboard plugin org.marea.absent: required artifact missing. Rebuild or enable compatible release artifacts.",
  );
});
it("carries a bounded typed diagnostic with a closed reason and fixed remedy", () => {
  const failure = (changed: object) => {
    try {
      validateDashboardProfileRelease({ ...release, ...changed });
    } catch (error) {
      if (error instanceof DashboardReleaseError) return error.diagnostic;
      throw error;
    }
    throw new Error("Release was accepted");
  };
  const module = release.modules[0];
  const cases: [object, string, DashboardReleaseReason][] = [
    [{ modules: [...release.modules, ...release.modules] }, "catalog", "duplicate-ids"],
    [{ requiredIds: ["org.marea.absent"] }, "org.marea.absent", "required-missing"],
    [{ requiredIds: [module.id], capabilities: [] }, module.id, "required-unavailable"],
    [
      { modules: [{ ...module, conflicts: [release.defaults.themeId] }] },
      module.id,
      "conflicting-artifact",
    ],
    [
      {
        modules: Array.from({ length: 65 }, (_, i) => ({ ...module, id: `org.m-${String(i)}` })),
      },
      "catalog",
      "descriptor-limit",
    ],
    [{ requiredIds: [`a${"b".repeat(160)}`] }, "unrecognized", "required-missing"],
    [{ requiredIds: ["bad id\n"] }, "unrecognized", "required-missing"],
  ];
  for (const [changed, pluginId, reason] of cases)
    expect(failure(changed)).toEqual({
      kind: "dashboard-release",
      pluginId,
      reason,
      remedy: "rebuild-compatible-release",
    });
  expect(failure({ requiredIds: [`a${"b".repeat(159)}`] }).pluginId).toHaveLength(160);
  expect(() => validateDashboardProfileRelease({ ...release, requiredIds: ["bad id"] })).toThrow(
    "Dashboard plugin unrecognized: required artifact missing.",
  );
});
