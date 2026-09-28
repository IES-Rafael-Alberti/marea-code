import * as z from "zod";
import { expect, expectTypeOf, it } from "vitest";
import { createDashboardProfileDocumentSchema } from "./dashboard-profile-document.boundary.js";
import {
  createDashboardModuleSelectionSchema,
  createDashboardProfileSchemas,
  DashboardPluginIdSchema,
  DashboardCatalogRevisionSchema,
  DashboardModulePlacementSchema,
  DashboardProfileWarningSchema,
} from "./dashboard-profiles.js";

it("accepts complete warnings and every placement preset", () => {
  for (const code of [
    "module-unavailable",
    "module-incompatible",
    "module-forbidden",
    "settings-invalid",
    "theme-unavailable",
    "profile-invalid",
    "profile-version-unsupported",
  ]) {
    const warning = { code, moduleId: "org.marea.module", themeId: "org.marea.theme" };
    expect(DashboardProfileWarningSchema.parse(warning)).toEqual(warning);
  }
  for (const slot of ["main", "aside"])
    for (const size of ["compact", "standard", "wide"])
      expect(DashboardModulePlacementSchema.parse({ slot, size })).toEqual({ slot, size });
});
it("bounds catalog IDs and digest formats exactly", () => {
  const maximal = `a.${"b".repeat(158)}`;
  for (const id of ["a.b", "org.marea.module-1", maximal])
    expect(DashboardPluginIdSchema.parse(id)).toBe(id);
  for (const id of ["!a.b", "a.b!", "A.b", "a.B", maximal + "b"])
    expect(DashboardPluginIdSchema.safeParse(id).success).toBe(false);
  for (const digest of ["!" + "a".repeat(64), "a".repeat(64) + "!"])
    expect(DashboardCatalogRevisionSchema.safeParse(digest).success).toBe(false);
});
it("bounds configuration versions and rejects pairs not in the module placement set", () => {
  const settings = z.strictObject({ label: z.string() });
  const placements = [
    { slot: "main", size: "compact" },
    { slot: "aside", size: "wide" },
  ] as const;
  for (const version of [1, 1_000_000]) {
    const schema = createDashboardModuleSelectionSchema(
      "org.marea.example",
      version,
      settings,
      placements,
    );
    const input = {
      moduleId: "org.marea.example",
      configurationVersion: version,
      enabled: true,
      settings: { label: "x" },
      placement: placements[1],
    };
    expect(schema.parse(input)).toEqual(input);
    for (const placement of [
      { slot: "main", size: "wide" },
      { slot: "aside", size: "compact" },
    ])
      expect(schema.safeParse({ ...input, placement }).success).toBe(false);
  }
});
it("bounds compositions at 32 unique modules and filters disabled effective values", () => {
  const selections = Array.from({ length: 33 }, (_, index) =>
    createDashboardModuleSelectionSchema(`org.marea.m${String(index)}`, 1, z.strictObject({}), [
      { slot: "main", size: "standard" },
    ]),
  );
  const schemas = createDashboardProfileSchemas(z.union(selections), z.literal("org.marea.theme"));
  const modules = Array.from({ length: 33 }, (_, index) => ({
    moduleId: `org.marea.m${String(index)}`,
    configurationVersion: 1,
    enabled: true,
    placement: { slot: "main", size: "standard" },
    settings: {},
  }));
  const value = { themeId: "org.marea.theme", modules: modules.slice(0, 32) };
  expect(schemas.personalValue.parse(value)).toEqual(value);
  expect(schemas.personalValue.safeParse({ ...value, modules }).success).toBe(false);
  const resetRecord = {
    revision: "r1",
    updatedAt: "2026-09-22T00:00:00Z",
    status: "default",
    value: null,
  };
  expect(schemas.personal.parse(resetRecord)).toEqual(resetRecord);
  const neverWrittenValid = { revision: null, updatedAt: null, status: "valid", value };
  expect(schemas.personal.safeParse(neverWrittenValid).success).toBe(false);
  const state = {
    protocolVersion: "0.1",
    requestId: "r1",
    kind: "dashboard-profile-state",
    schemaVersion: 1,
    scope: { kind: "teacher" },
    generatedAt: resetRecord.updatedAt,
    catalogRevision: "a".repeat(64),
    personal: resetRecord,
    override: null,
    effective: { ...value, modules: [] },
    warnings: [],
  };
  expect(schemas.state.parse(state).effective.modules).toEqual([]);
  expect(
    schemas.state.safeParse({
      ...state,
      effective: { ...value, modules: [modules[0], { ...modules[1], enabled: false }] },
    }).success,
  ).toBe(false);
});
it("enforces byte limits before parsing and reports sanitized UTF-8/shape failures", () => {
  const schema = z.strictObject({ label: z.string() });
  const request = createDashboardProfileDocumentSchema(schema, "request");
  const response = createDashboardProfileDocumentSchema(schema, "response");
  const json = JSON.stringify({ label: "valid" });
  expect(() => request.parse(new TextEncoder().encode(json.padEnd(65_537)))).toThrow(
    "Dashboard profile document exceeds byte limit.",
  );
  expect(response.parse(new TextEncoder().encode(json.padEnd(262_144)))).toEqual({
    label: "valid",
  });
  const invalidUtf8 = new TextEncoder().encode('{"label":"X"}');
  invalidUtf8[10] = 255;
  for (const input of [
    invalidUtf8,
    new TextEncoder().encode("{"),
    new TextEncoder().encode('{"extra":"secret"}'),
  ])
    expect(() => request.parse(input)).toThrow("Invalid dashboard profile UTF-8 JSON document.");
  expect(() => response.parse(new TextEncoder().encode(json.padEnd(262_145)))).toThrow(
    "Dashboard profile document exceeds byte limit.",
  );
});

it("uses the stable custom issue code for sanitized boundary failures", () => {
  const schema = createDashboardProfileDocumentSchema(z.strictObject({}), "request");
  const result = schema.safeParse(new TextEncoder().encode("{"));
  expect(result.error?.issues).toEqual([
    { code: "custom", path: [], message: "Invalid dashboard profile UTF-8 JSON document." },
  ]);
});

it("retains literal module identity/version and typed settings in the executable union", () => {
  const settings = z.strictObject({ label: z.string() });
  const placements = [{ slot: "main", size: "standard" }] as const;
  const selection = createDashboardModuleSelectionSchema(
    "org.marea.example",
    1,
    settings,
    placements,
  );
  expect(selection.shape.moduleId.parse("org.marea.example")).toBe("org.marea.example");
  expectTypeOf<z.infer<typeof selection>["moduleId"]>().toEqualTypeOf<"org.marea.example">();
  expectTypeOf<z.infer<typeof selection>["configurationVersion"]>().toEqualTypeOf<1>();
  expectTypeOf<z.infer<typeof selection>["settings"]>().toEqualTypeOf<{ label: string }>();
  expect(() => createDashboardModuleSelectionSchema("invalid", 1, settings, placements)).toThrow();
  for (const version of [0, 1_000_001])
    expect(() =>
      createDashboardModuleSelectionSchema("org.marea.example", version, settings, placements),
    ).toThrow();
});
