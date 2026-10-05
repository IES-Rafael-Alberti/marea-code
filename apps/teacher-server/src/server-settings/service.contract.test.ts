import { expect, it, vi } from "vitest";
import { inferenceProviderCatalog } from "@marea/plugin-runtime";
import type { InferenceProviderCatalogEntry } from "@marea/plugin-api";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { SYNTHETIC_ROUTE_BUDGET, USAGE_POLICY } from "../../test-support/usage-fixture.js";
import type { ServerSettings } from "./contracts.js";
import { ServerSettingsService } from "./service.boundary.js";

const teacher: AuthenticatedIdentity = {
  userId: "user:owner",
  role: "teacher",
  classId: null,
  displayName: "Owner",
};
const openrouter = "org.marea.openrouter";
const defaultEndpoint = "https://openrouter.ai/api/v1/chat/completions";
const base = inferenceProviderCatalog[0];
if (base?.manifest.id !== openrouter) throw new Error("missing OpenRouter fixture");
const encode = (input: object) => new TextEncoder().encode(JSON.stringify(input));
const status = (code: number) =>
  expect.objectContaining({ status: code, message: "Server settings request failed" }) as object;

function setup(
  initial: Partial<ServerSettings> = {},
  catalog: readonly InferenceProviderCatalogEntry[] = inferenceProviderCatalog,
) {
  let value: ServerSettings = {
    version: 1,
    revision: 0,
    administrators: [teacher.userId],
    connections: { [openrouter]: { apiKey: "synthetic-secret-value" } },
    route: null,
    education: {},
    legacyRoutes: [],
    useCommonRoute: false,
    ...initial,
  };
  const write = vi.fn((next: ServerSettings) => {
    value = next;
  });
  const service = new ServerSettingsService({ read: () => value, write }, catalog);
  const save = (overrides: object) =>
    service.execute(
      teacher,
      encode({
        operation: "save",
        expectedRevision: value.revision,
        connections: { [openrouter]: {} },
        route: null,
        education: {},
        useCommonRoute: false,
        ...overrides,
      }),
    );
  return { service, write, save, current: () => value };
}

it("rejects malformed bytes and closed-schema violations as bad requests", () => {
  const f = setup();
  const malformed = new TextEncoder().encode(
    `{"operation":"save","expectedRevision":0,"connections":{"${openrouter}":{"apiKey":"synthetic-secret-`,
  );
  const invalidUtf8 = new Uint8Array([
    ...malformed,
    0xff,
    ...new TextEncoder().encode('-value"}},"route":null,"education":{},"useCommonRoute":false}'),
  ]);
  for (const input of [invalidUtf8, encode({ operation: "erase" }), new Uint8Array([123])])
    expect(() => f.service.execute(teacher, input)).toThrow(status(400));
  expect(f.write).not.toHaveBeenCalled();
});

it("requires a connection for task routes and allows adopting a complete common route", () => {
  const f = setup();
  const map = {
    providerId: "org.marea.missing",
    model: "synthetic-map-model",
    budget: USAGE_POLICY,
    inputTokenCeiling: USAGE_POLICY.maxInputTokens,
  };
  expect(() => f.save({ education: { map } })).toThrow(status(400));
  const route = {
    providerId: openrouter,
    model: "synthetic-model",
    budget: SYNTHETIC_ROUTE_BUDGET,
  };
  expect(f.save({ route, useCommonRoute: true })).toMatchObject({
    initialized: true,
    useCommonRoute: true,
    route,
  });
});

it("uses each plugin's own descriptor and passes endpoints and empty keys to validation", () => {
  const create = vi.fn(base.create);
  const label = { es: "Clave", en: "Key", eu: "Gakoa" };
  const custom = vi.fn((configuration: Parameters<typeof base.create>[0]) =>
    base.create({ apiKey: configuration.settings?.token ?? "" }),
  );
  const plugin: InferenceProviderCatalogEntry = {
    manifest: { ...base.manifest, id: "synthetic.provider" },
    settings: {
      version: 1,
      name: label,
      fields: [{ key: "token", label, kind: "secret", required: true }],
    },
    create: custom,
  };
  const f = setup({}, [{ ...base, create }, plugin]);
  f.save({
    connections: {
      [openrouter]: { endpoint: "https://provider.example.test/v1/chat/completions" },
      "synthetic.provider": { token: "synthetic-token-value" },
    },
  });
  expect(create.mock.calls[0]?.[0]).toStrictEqual({
    apiKey: "synthetic-secret-value",
    endpoint: "https://provider.example.test/v1/chat/completions",
    settings: {
      apiKey: "synthetic-secret-value",
      endpoint: "https://provider.example.test/v1/chat/completions",
    },
  });
  expect(custom.mock.calls[0]?.[0]).toStrictEqual({
    apiKey: "",
    settings: { token: "synthetic-token-value" },
  });
});

it("keeps only omitted secrets: other fields return to their defaults", () => {
  const f = setup({
    connections: {
      [openrouter]: { apiKey: "synthetic-secret-value", endpoint: "https://old.test" },
    },
  });
  f.save({});
  expect(f.current().connections[openrouter]).toEqual({
    apiKey: "synthetic-secret-value",
    endpoint: defaultEndpoint,
  });
  const fresh = setup({ connections: {} });
  expect(() => fresh.save({})).toThrow(status(400));
});

it("projects public fields, secret presence and orphaned connections exactly once", () => {
  const f = setup({
    connections: {
      [openrouter]: { apiKey: "synthetic-secret-value", endpoint: "https://custom.test" },
      "org.marea.removed": { apiKey: "synthetic-orphan-secret" },
    },
  });
  const response = f.service.execute(teacher, encode({ operation: "read" }));
  expect(response).toMatchObject({
    initialized: true,
    providers: [
      { id: openrouter, values: { endpoint: "https://custom.test" }, secrets: ["apiKey"] },
      { id: "org.marea.removed", descriptor: null, configured: true, values: {}, secrets: [] },
    ],
  });
  expect(JSON.stringify(response)).not.toContain("synthetic-orphan-secret");
  const empty = setup({ connections: { [openrouter]: {} } });
  expect(empty.service.execute(teacher, encode({ operation: "read" }))).toMatchObject({
    providers: [{ id: openrouter, values: {}, secrets: [] }],
  });
});
