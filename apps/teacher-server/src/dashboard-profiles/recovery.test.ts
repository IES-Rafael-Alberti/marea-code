import { afterEach, beforeEach, expect, it } from "vitest";
import {
  profileHarness,
  release,
  selected,
  request,
  write,
  classScope,
} from "./profile.fixture.js";
let h: ReturnType<typeof profileHarness>;
beforeEach(() => {
  h = profileHarness();
});
afterEach(() => {
  h.database.close();
});
function stored(serializedValue: string | null, schemaVersion = 1, classId: string | null = null) {
  h.store.write("teacher-1", classId, {
    revision: "old",
    updatedAt: "2026-09-22T00:00:00Z",
    schemaVersion,
    serializedValue,
  });
}
it.each(["{", "[]", '{"extra":true}', "{}", '{"themeId":"org.marea.example"}', '{"modules":[]}'])(
  "recovers corrupt personal data %s without writing",
  (raw) => {
    stored(raw);
    expect(h.read()).toMatchObject({
      personal: { status: "recovery-required", revision: "old", value: null },
      effective: release.defaults,
      warnings: [{ code: "profile-invalid" }],
    });
    expect(h.store.read("teacher-1", null)?.serializedValue).toBe(raw);
    expect(() =>
      h.execute(
        "save",
        write({
          expectedRevision: "old",
          expectedPersonalRevision: "old",
          discardUnavailable: true,
        }),
      ),
    ).toThrow();
    h.execute(
      "reset",
      request("reset", {
        expectedRevision: "old",
        expectedPersonalRevision: "old",
        catalogRevision: release.revision,
      }),
    );
    expect(h.read().personal).toMatchObject({ revision: "profile-1", status: "default" });
  },
);
it("rejects ordinary future-schema overwrites, including future reset markers", () => {
  stored(null, 2);
  expect(h.read()).toMatchObject({
    personal: { status: "recovery-required" },
    warnings: [{ code: "profile-version-unsupported" }],
  });
});
it("ignores only a corrupt class override and keeps valid personal state", () => {
  h.execute("save", write({ value: { ...release.defaults, modules: [] } }));
  stored("{}", 1, "class-1");
  expect(h.read(classScope)).toMatchObject({
    personal: { status: "valid" },
    override: { status: "recovery-required" },
    effective: { modules: [] },
  });
});
it.each([
  [{ ...selected, moduleId: "org.marea.removed" }, "module-unavailable"],
  [{ ...selected, configurationVersion: 2 }, "module-incompatible"],
  [{ ...selected, settings: { limit: 0 } }, "settings-invalid"],
] as const)("preserves unavailable selections and requires explicit discard", (module, code) => {
  const value = { themeId: "org.marea.removed-theme", modules: [module] };
  const raw = JSON.stringify(value);
  stored(raw);
  expect(h.read()).toMatchObject({
    personal: { status: "valid", value: { themeId: release.defaults.themeId, modules: [] } },
    warnings: [
      { code: "theme-unavailable", themeId: value.themeId },
      { code, moduleId: module.moduleId },
    ],
  });
  expect(h.store.read("teacher-1", null)?.serializedValue).toBe(raw);
  expect(() =>
    h.execute("save", write({ expectedRevision: "old", expectedPersonalRevision: "old" })),
  ).toThrow();
  h.execute(
    "save",
    write({ expectedRevision: "old", expectedPersonalRevision: "old", discardUnavailable: true }),
  );
  expect(h.read().warnings).toEqual([]);
});
it("suppresses forbidden saved modules in editable and effective projections", () => {
  stored(JSON.stringify(release.defaults));
  h.runtime.permitted = false;
  expect(h.read()).toMatchObject({
    effective: { modules: [] },
    warnings: [{ code: "module-forbidden", moduleId: selected.moduleId }],
  });
  h.runtime.permitted = true;
  expect(h.read().effective).toEqual(release.defaults);
});
it("bounds warnings across personal and class scopes while retaining opaque references", () => {
  const modules = Array.from({ length: 32 }, (_, i) => ({
    ...selected,
    moduleId: `org.marea.missing-${String(i)}`,
  }));
  const raw = JSON.stringify({ themeId: "org.marea.missing-theme", modules });
  stored(raw);
  stored(raw, 1, "class-1");
  expect(h.read(classScope).warnings).toHaveLength(64);
  expect(h.store.read("teacher-1", "class-1")?.serializedValue).toBe(raw);
});
it("rejects duplicate stored modules and supports a valid module-only class override", () => {
  stored(JSON.stringify({ ...release.defaults, modules: [selected, selected] }));
  expect(h.read().personal.status).toBe("recovery-required");
  stored(JSON.stringify({ modules: [selected] }), 1, "class-1");
  expect(h.read(classScope).override).toMatchObject({
    status: "valid",
    value: { modules: [selected] },
  });
});
it("requires disclosure when replacing only an unavailable theme", () => {
  stored(JSON.stringify({ themeId: "org.marea.missing-theme", modules: [] }));
  expect(() =>
    h.execute("save", write({ expectedRevision: "old", expectedPersonalRevision: "old" })),
  ).toThrow(expect.objectContaining({ status: 409 }));
});
