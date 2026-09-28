import { expect, it } from "vitest";
import { recoverDashboardProfile } from "./recovery.boundary.js";
import { validateDashboardProfileRelease } from "./release.js";
import { release } from "./release.fixture.js";
const validated = validateDashboardProfileRelease(release);
const base = {
  schemaVersion: 1,
  revision: "saved",
  updatedAt: "2026-09-22T00:00:00Z",
  serializedValue: null,
};
it("returns an explicit recovery marker without an implicit discard authorization", () => {
  expect(
    recoverDashboardProfile({ ...base, schemaVersion: 2 }, true, validated, () => true),
  ).toEqual({
    record: {
      revision: "saved",
      updatedAt: base.updatedAt,
      status: "recovery-required",
      value: null,
    },
    warnings: [{ code: "profile-version-unsupported" }],
    discarded: false,
  });
});
it("bounds legacy stored documents before parsing", () => {
  const text = JSON.stringify(release.defaults).padEnd(65_537);
  expect(
    recoverDashboardProfile({ ...base, serializedValue: text }, true, validated, () => true).record
      .status,
  ).toBe("recovery-required");
});
it("resolves themes by membership in a multi-theme catalog", () => {
  const themes = [...release.themes, { ...release.themes[0], id: "org.marea.second-theme" }];
  const result = recoverDashboardProfile(
    { ...base, serializedValue: JSON.stringify(release.defaults) },
    true,
    validateDashboardProfileRelease({ ...release, themes }),
    () => true,
  );
  expect(result.warnings).toEqual([]);
  expect(result.discarded).toBe(false);
});
