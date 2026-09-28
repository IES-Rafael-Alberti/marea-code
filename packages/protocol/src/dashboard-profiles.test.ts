import * as z from "zod";
import { describe, expect, it } from "vitest";
import { createDashboardProfileDocumentSchema } from "./dashboard-profile-document.boundary.js";
import {
  createDashboardModuleSelectionSchema,
  createDashboardProfileSchemas,
  createDashboardProfileCatalogResultSchema,
  DashboardProfileReadRequestSchema,
  DashboardProfileResetRequestSchema,
} from "./dashboard-profiles.js";

const placement = { slot: "main", size: "standard" } as const;
const selection = createDashboardModuleSelectionSchema(
  "org.marea.example",
  1,
  z.object({ label: z.string() }),
  [placement],
);
const schemas = createDashboardProfileSchemas(selection, z.literal("org.marea.theme"));
const module = {
  moduleId: "org.marea.example",
  configurationVersion: 1,
  enabled: true,
  placement,
  settings: { label: "test" },
};
const value = { themeId: "org.marea.theme", modules: [module] };
const envelope = { protocolVersion: "0.1", requestId: "request-1" };
const concurrency = {
  expectedRevision: null,
  expectedPersonalRevision: null,
  catalogRevision: "a".repeat(64),
};
const save = {
  ...envelope,
  ...concurrency,
  kind: "dashboard-profile-save",
  scope: { kind: "teacher" },
  value,
  discardUnavailable: false,
};
const reset = {
  ...envelope,
  ...concurrency,
  kind: "dashboard-profile-reset",
  scope: { kind: "teacher" },
};
const record = { revision: null, updatedAt: null, status: "default", value: null };
const state = {
  ...envelope,
  kind: "dashboard-profile-state",
  schemaVersion: 1,
  scope: { kind: "teacher" },
  generatedAt: "2026-09-22T00:00:00Z",
  catalogRevision: "a".repeat(64),
  personal: record,
  override: null,
  effective: value,
  warnings: [],
};
const encode = (input: object) => new TextEncoder().encode(JSON.stringify(input));

describe("dashboard profile contracts", () => {
  it("preserves typed settings, whole-field overrides and explicit empty panels", () => {
    expect(schemas.save.parse(save).value).toEqual(value);
    expect(schemas.personalValue.parse({ ...value, modules: [] }).modules).toEqual([]);
    expect(schemas.classValue.parse({ modules: [] })).toEqual({ modules: [] });
    expect(schemas.classValue.parse({ themeId: value.themeId })).toEqual({
      themeId: value.themeId,
    });
    expect(schemas.classValue.safeParse({}).success).toBe(false);
    expect(
      schemas.save.parse({
        ...save,
        scope: { kind: "class", classId: "class-1" },
        expectedPersonalRevision: "personal-2",
        value: { modules: [] },
      }).value,
    ).toEqual({ modules: [] });
    expect(DashboardProfileResetRequestSchema.parse(reset)).toEqual(reset);
    expect(
      DashboardProfileResetRequestSchema.parse({
        ...reset,
        scope: { kind: "class", classId: "class-1" },
        expectedPersonalRevision: "p2",
      }).expectedPersonalRevision,
    ).toBe("p2");
  });
  it.each([
    { actorId: "teacher" },
    { schemaVersion: 2 },
    { value: null },
    { expectedPersonalRevision: "p2" },
    { catalogRevision: "old" },
    { protocolVersion: "1.0" },
    { value: { ...value, locale: "en" } },
    { value: { modules: [] } },
    { scope: { kind: "class", classId: "c", owner: "other" } },
    { value: { ...value, modules: [module, module] } },
    { value: { ...value, themeId: "org.marea.missing" } },
  ])("rejects forged or stale-shaped saves %#", (change) => {
    expect(schemas.save.safeParse({ ...save, ...change }).success).toBe(false);
  });
  it.each([
    { moduleId: "org.marea.missing" },
    { configurationVersion: 2 },
    { placement: { slot: "aside", size: "wide" } },
    { settings: { label: "x", secret: true } },
    { settings: { label: 1 } },
    { settings: { label: "é".repeat(2048) } },
  ])("rejects invalid module selections %#", (change) => {
    expect(selection.safeParse({ ...module, ...change }).success).toBe(false);
  });
  it("counts serialized settings UTF-8 and escaping exactly", () => {
    const maximum = "x".repeat(4084);
    expect(selection.parse({ ...module, settings: { label: maximum } }).settings.label).toBe(
      maximum,
    );
    expect(selection.safeParse({ ...module, settings: { label: maximum + "x" } }).success).toBe(
      false,
    );
    expect(selection.safeParse({ ...module, settings: { label: "\n".repeat(2043) } }).success).toBe(
      false,
    );
  });
  it("validates editable records, recovery and effective enabled selections", () => {
    expect(schemas.state.parse(state)).toEqual(state);
    const valid = { revision: "r1", updatedAt: state.generatedAt, status: "valid", value };
    expect(schemas.personal.parse(valid)).toEqual(valid);
    expect(
      schemas.personal.parse({ ...valid, status: "recovery-required", value: null }).status,
    ).toBe("recovery-required");
    for (const invalid of [
      { ...record, revision: "r1" },
      { ...record, status: "valid" },
      { ...valid, value: null },
      { ...record, status: "recovery-required" },
      { ...record, value },
    ])
      expect(schemas.personal.safeParse(invalid).success).toBe(false);
    expect(schemas.state.safeParse({ ...state, override: record }).success).toBe(false);
    expect(
      schemas.state.safeParse({ ...state, scope: { kind: "class", classId: "c" } }).success,
    ).toBe(false);
    expect(
      schemas.state.parse({ ...state, scope: { kind: "class", classId: "c" }, override: record })
        .override,
    ).toEqual(record);
    expect(
      schemas.state.safeParse({
        ...state,
        effective: { ...value, modules: [{ ...module, enabled: false }] },
      }).success,
    ).toBe(false);
    expect(
      schemas.state.safeParse({
        ...state,
        warnings: Array.from({ length: 65 }, () => ({ code: "module-unavailable" })),
      }).success,
    ).toBe(false);
  });
  it("bounds bytes before parsing and rejects malformed UTF-8, JSON and envelopes", () => {
    const request = createDashboardProfileDocumentSchema(schemas.request, "request");
    const read = { ...envelope, kind: "dashboard-profile-read", scope: { kind: "teacher" } };
    expect(request.parse(encode(read))).toEqual(read);
    expect(request.parse(encode(save))).toEqual(save);
    expect(request.parse(encode(reset))).toEqual(reset);
    expect(request.parse(encode({ ...read, kind: "dashboard-profile-catalog" })).kind).toBe(
      "dashboard-profile-catalog",
    );
    for (const bytes of [
      new Uint8Array(65_537),
      new Uint8Array([255]),
      new TextEncoder().encode("{"),
      encode({ ...read, extra: true }),
    ])
      expect(request.safeParse(bytes).success).toBe(false);
    const text = JSON.stringify(read);
    expect(request.parse(new TextEncoder().encode(text.padEnd(65_536)))).toEqual(read);
    const response = createDashboardProfileDocumentSchema(schemas.state, "response");
    expect(response.parse(new TextEncoder().encode(JSON.stringify(state).padEnd(262_144)))).toEqual(
      state,
    );
    expect(response.safeParse(new Uint8Array(262_145)).success).toBe(false);
    expect(DashboardProfileReadRequestSchema.safeParse({ ...read, actor: "forged" }).success).toBe(
      false,
    );
    expect(
      DashboardProfileResetRequestSchema.safeParse({ ...reset, expectedPersonalRevision: "p2" })
        .success,
    ).toBe(false);
  });
  it("bounds catalog descriptors and release defaults", () => {
    const catalog = createDashboardProfileCatalogResultSchema(
      z.strictObject({ id: z.string() }),
      z.strictObject({ id: z.string() }),
      schemas.personalValue,
    );
    const input = {
      ...envelope,
      kind: "dashboard-profile-catalog-result",
      scope: { kind: "teacher" },
      catalogRevision: concurrency.catalogRevision,
      modules: Array.from({ length: 64 }, () => ({ id: "module" })),
      themes: Array.from({ length: 16 }, () => ({ id: "theme" })),
      releaseDefaults: value,
    };
    expect(catalog.parse(input)).toEqual(input);
    expect(
      catalog.safeParse({ ...input, modules: [...input.modules, { id: "extra" }] }).success,
    ).toBe(false);
    expect(
      catalog.safeParse({ ...input, themes: [...input.themes, { id: "extra" }] }).success,
    ).toBe(false);
  });
});
