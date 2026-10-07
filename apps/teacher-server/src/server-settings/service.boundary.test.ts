import { describe, expect, it, vi } from "vitest";
import { inferenceProviderCatalog } from "@marea/plugin-runtime";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { ServerSettings } from "./contracts.js";
import { ServerSettingsService } from "./service.boundary.js";
const teacher: AuthenticatedIdentity = {
  userId: "user:owner",
  role: "teacher",
  classId: null,
  displayName: "Owner",
};
const bytes = (input: object) => new TextEncoder().encode(JSON.stringify(input));
function fixture(initial: Partial<ServerSettings> = {}) {
  let value: ServerSettings = {
    version: 1,
    legacyRoutes: [],
    revision: 0,
    administrators: [teacher.userId],
    connections: { "org.marea.openrouter": { apiKey: "synthetic-secret-value" } },
    route: null,
    education: {},
    useCommonRoute: false,
    ...initial,
  };
  const write = vi.fn((next: ServerSettings) => {
    value = next;
  });
  const changed = vi.fn();
  const service = new ServerSettingsService(
    { read: () => value, write },
    inferenceProviderCatalog,
    changed,
  );
  const save = (overrides: object = {}) =>
    bytes({
      operation: "save",
      expectedRevision: value.revision,
      connections: { "org.marea.openrouter": {} },
      route: null,
      education: {},
      useCommonRoute: false,
      ...overrides,
    });
  return { service, write, changed, save, current: () => value };
}
describe("server-owned provider settings", () => {
  it("projects runtime connection addresses only to administrators and never persists them", () => {
    const f = fixture();
    const connectionOrigins = ["http://10.0.4.25:18787", "https://school.test"];
    const service = new ServerSettingsService(
      { read: f.current, write: f.write },
      inferenceProviderCatalog,
      undefined,
      connectionOrigins,
    );
    expect(service.execute(teacher, bytes({ operation: "read" }))).toMatchObject({
      connectionOrigins,
    });
    expect(service.execute(teacher, f.save())).toMatchObject({ connectionOrigins });
    expect(f.current()).not.toHaveProperty("connectionOrigins");
    expect(
      service.execute({ ...teacher, userId: "other" }, bytes({ operation: "read" })),
    ).not.toHaveProperty("connectionOrigins");
    expect(f.service.execute(teacher, bytes({ operation: "read" }))).toMatchObject({
      connectionOrigins: [],
    });
  });
  it("returns descriptors and secret presence without exposing saved credentials", () => {
    const f = fixture();
    const response = f.service.execute(teacher, bytes({ operation: "read" }));
    expect(response).toMatchObject({
      administrator: true,
      revision: 0,
      providers: [expect.objectContaining({ secrets: ["apiKey"], values: {} })],
    });
    expect(JSON.stringify(response)).not.toContain("synthetic-secret-value");
  });
  it("requires explicit installation authority, including on every write", () => {
    const f = fixture();
    const other = { ...teacher, userId: "user:other" };
    expect(f.service.execute(other, bytes({ operation: "read" }))).toEqual({
      administrator: false,
      initialized: true,
    });
    expect(() => f.service.execute(other, f.save())).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => f.service.execute({ ...teacher, role: "student" }, f.save())).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(f.write).not.toHaveBeenCalled();
  });
  it("retains an omitted secret, rotates an explicit secret and permits removing an unused connection", () => {
    const f = fixture();
    void f.service.execute(teacher, f.save());
    expect(f.current().connections["org.marea.openrouter"]?.apiKey).toBe("synthetic-secret-value");
    void f.service.execute(
      teacher,
      f.save({
        connections: { "org.marea.openrouter": { apiKey: "replacement-synthetic-secret" } },
      }),
    );
    expect(f.current().connections["org.marea.openrouter"]?.apiKey).toBe(
      "replacement-synthetic-secret",
    );
    void f.service.execute(teacher, f.save({ connections: {} }));
    expect(f.current().connections).toEqual({});
    expect(f.changed).toHaveBeenCalledTimes(3);
  });
  it("keeps a connection that an imported class route still uses", () => {
    const route = { providerId: "org.marea.openrouter", model: "imported-model" };
    const f = fixture({ legacyRoutes: [{ classId: "class:imported", route }] });
    expect(() => f.service.execute(teacher, f.save({ connections: {} }))).toThrow();
    expect(f.write).not.toHaveBeenCalled();
    void f.service.execute(teacher, f.save());
    expect(f.write).toHaveBeenCalledOnce();
  });
  it("rejects stale writes, unknown fields, invalid credentials and unconfigured routes", () => {
    const f = fixture();
    for (const change of [
      { expectedRevision: 9 },
      { connections: { missing: {} } },
      { connections: { "org.marea.openrouter": { unexpected: "value" } } },
      { connections: { "org.marea.openrouter": { apiKey: "short" } } },
      { route: { providerId: "missing", model: "model" }, useCommonRoute: true },
      { useCommonRoute: true },
    ])
      expect(() => f.service.execute(teacher, f.save(change))).toThrow();
    expect(f.write).not.toHaveBeenCalled();
  });
  it("preserves a stored connection when its plugin is unavailable without exposing its fields", () => {
    const f = fixture();
    const current = f.current();
    const service = new ServerSettingsService({ read: f.current, write: f.write }, []);
    const response = service.execute(teacher, bytes({ operation: "read" }));
    expect(response).toMatchObject({
      providers: [
        { id: "org.marea.openrouter", descriptor: null, configured: true, values: {}, secrets: [] },
      ],
    });
    expect(JSON.stringify(response)).not.toContain("synthetic-secret-value");
    void service.execute(teacher, f.save());
    expect(f.write).toHaveBeenCalledWith(
      expect.objectContaining({ connections: current.connections }),
      0,
    );
    expect(
      () =>
        void service.execute(
          teacher,
          f.save({ connections: { "org.marea.openrouter": { apiKey: "replacement" } } }),
        ),
    ).toThrow();
  });
  it("does not infer administrator authority before offline initialization", () => {
    const service = new ServerSettingsService({ read: () => null, write: vi.fn() }, []);
    expect(service.execute(teacher, bytes({ operation: "read" }))).toEqual({
      administrator: false,
      initialized: false,
    });
    expect(
      () =>
        void service.execute(
          teacher,
          bytes({ operation: "read", administrators: [teacher.userId] }),
        ),
    ).toThrow();
    expect(() => service.execute(teacher, new Uint8Array([255]))).toThrow();
  });
  it("uses a synthetic plugin's custom descriptor and validator without OpenRouter-specific fields", () => {
    const base = inferenceProviderCatalog[0];
    if (!base) throw new Error("missing provider fixture");
    const create = vi.fn(base.create);
    const plugin = {
      ...base,
      manifest: { ...base.manifest, id: "synthetic.provider" },
      settings: {
        version: 1 as const,
        name: { es: "Prueba", en: "Test", eu: "Proba" },
        fields: [
          {
            key: "token",
            label: { es: "Token", en: "Token", eu: "Token" },
            kind: "secret" as const,
            required: true,
          },
        ],
      },
      create: (config: Parameters<typeof base.create>[0]) =>
        create({ apiKey: config.settings?.token ?? "" }),
    };
    let value: ServerSettings = {
      version: 1,
      legacyRoutes: [],
      revision: 0,
      administrators: [teacher.userId],
      connections: {},
      route: null,
      education: {},
      useCommonRoute: false,
    };
    const service = new ServerSettingsService(
      {
        read: () => value,
        write: (next) => {
          value = next;
        },
      },
      [plugin],
    );
    const response = service.execute(
      teacher,
      bytes({
        operation: "save",
        expectedRevision: 0,
        connections: { "synthetic.provider": { token: "synthetic-custom-secret" } },
        route: null,
        education: {},
        useCommonRoute: false,
      }),
    );
    expect(create).toHaveBeenCalledWith({ apiKey: "synthetic-custom-secret" });
    expect(JSON.stringify(response)).not.toContain("synthetic-custom-secret");
  });
  it("requires mandatory fields, omits empty optional ones and lists plugins without a form", () => {
    const base = inferenceProviderCatalog[0];
    if (!base) throw new Error("missing provider fixture");
    const label = { es: "Campo", en: "Field", eu: "Eremua" };
    const plugin = {
      ...base,
      manifest: { ...base.manifest, id: "synthetic.provider" },
      settings: {
        version: 1 as const,
        name: label,
        fields: [
          { key: "token", label, kind: "secret" as const, required: true },
          { key: "region", label, kind: "text" as const, required: false },
        ],
      },
      create: () => base.create({ apiKey: "synthetic-validated-key" }),
    };
    const formless = {
      manifest: { ...base.manifest, id: "synthetic.formless" },
      create: base.create,
    };
    const f = fixture({ connections: {} });
    const service = new ServerSettingsService({ read: f.current, write: f.write }, [
      plugin,
      formless,
    ]);
    const save = (overrides: object) =>
      bytes({
        operation: "save",
        expectedRevision: f.current().revision,
        connections: {},
        route: null,
        education: {},
        useCommonRoute: false,
        ...overrides,
      });
    expect(
      () => void service.execute(teacher, save({ connections: { "synthetic.provider": {} } })),
    ).toThrow();
    // A route needs a captured budget even when its connection exists.
    expect(
      () =>
        void service.execute(
          teacher,
          save({
            connections: { "synthetic.provider": { token: "synthetic-token" } },
            route: { providerId: "synthetic.provider", model: "synthetic-model" },
          }),
        ),
    ).toThrow();
    expect(f.write).not.toHaveBeenCalled();
    void service.execute(
      teacher,
      save({ connections: { "synthetic.provider": { token: "synthetic-token" } } }),
    );
    expect(f.current().connections).toEqual({ "synthetic.provider": { token: "synthetic-token" } });
    expect(service.execute(teacher, bytes({ operation: "read" }))).toMatchObject({
      providers: [
        { id: "synthetic.provider", configured: true, values: {}, secrets: ["token"] },
        { id: "synthetic.formless", descriptor: null, configured: false, values: {}, secrets: [] },
      ],
    });
  });
});
