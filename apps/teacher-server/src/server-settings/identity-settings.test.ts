import { expect, it, vi } from "vitest";
import google from "../../../../plugins/identity/google-workspace/src/index.js";
import type { IdentityProviderCatalogEntry } from "@marea/plugin-api";
import { IdentitySettings } from "./identity-settings.js";
import { ServerSettingsService } from "./service.boundary.js";
import { ServerSettingsSchema, type ServerSettings } from "./contracts.js";

const id = google.manifest.id;
const credentials = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  domain: "school.test",
};
const runtime = { now: () => 0, fetch: vi.fn() };
const teacher = {
  userId: "user:teacher",
  role: "teacher" as const,
  classId: null,
  displayName: "Teacher",
};
const encode = (value: object) => new TextEncoder().encode(JSON.stringify(value));
const status = (value: number) => expect.objectContaining({ status: value }) as object;
function fixture(
  catalog: readonly IdentityProviderCatalogEntry[] = [google],
  initial: Partial<ServerSettings> = {},
) {
  let current = ServerSettingsSchema.parse({
    version: 1,
    revision: 0,
    administrators: [teacher.userId],
    connections: {},
    route: null,
    education: {},
    useCommonRoute: false,
    ...initial,
  });
  const store = {
    read: () => current,
    write: vi.fn((next: ServerSettings) => {
      current = next;
    }),
  };
  const options = { catalog, active: { [id]: credentials }, runtime };
  return {
    store,
    options,
    settings: new IdentitySettings(store, options),
    endpoint: new ServerSettingsService(store, [], undefined, [], options),
  };
}
it("projects only public values and secret presence, separately from runtime admission readiness", () => {
  const f = fixture();
  expect(f.settings.read(f.store.read())).toMatchObject({
    revision: 0,
    restart: false,
    providers: [
      {
        id,
        configured: true,
        values: { clientId: credentials.clientId, domain: credentials.domain },
        secrets: ["clientSecret"],
      },
    ],
  });
  expect(JSON.stringify(f.settings.read(f.store.read()))).not.toContain(credentials.clientSecret);
  expect(f.settings.status()).toMatchObject({
    providers: [
      {
        id,
        kinds: [
          { kind: "email", ready: true },
          { kind: "group", ready: false },
        ],
      },
    ],
  });
  expect(runtime.fetch).not.toHaveBeenCalled();
});
it("preserves omitted secrets, increments the shared revision and keeps running credentials until restart", () => {
  const f = fixture();
  const response = f.settings.save(f.store.read(), 0, {
    [id]: { clientId: "changed", domain: credentials.domain },
  });
  expect(response).toMatchObject({
    revision: 1,
    restart: true,
    providers: [{ secrets: ["clientSecret"] }],
  });
  expect(f.store.read().identityConnections?.[id]).toEqual({ ...credentials, clientId: "changed" });
  expect(f.options.active[id]).toEqual(credentials);
  expect(f.store.write).toHaveBeenCalledWith(f.store.read(), 0);
  const replaced = { ...credentials, clientSecret: "replacement" };
  f.settings.save(f.store.read(), 1, { [id]: replaced });
  expect(f.store.read().identityConnections?.[id]).toEqual(replaced);
  const disabled = f.settings.save(f.store.read(), 2, {});
  expect(disabled.providers[0]).toMatchObject({ configured: false, values: {}, secrets: [] });
  expect(f.store.read().identityConnections).toEqual({});
});
it("refuses conflicts, unknown providers or fields, missing required fields and plugin-invalid settings without writing", () => {
  const f = fixture();
  expect(() => f.settings.save(f.store.read(), 4, {})).toThrow(status(409));
  for (const connections of [
    { missing: credentials },
    { [id]: { ...credentials, extra: "unknown" } },
    { [id]: {} },
    { [id]: { ...credentials, domain: "invalid" } },
    { [id]: { ...credentials, serviceAccountEmail: "service@school.test" } },
  ])
    expect(() => f.settings.save(f.store.read(), 0, connections)).toThrow(status(400));
  expect(f.store.write).not.toHaveBeenCalled();
});
it("supports optional fields, defaults, absent guides and legacy plugins without readiness methods", () => {
  const entry: IdentityProviderCatalogEntry = {
    ...google,
    settings: {
      ...google.settings,
      guides: undefined,
      fields: [
        { key: "optional", kind: "text", required: false, label: google.settings.name },
        {
          key: "domain",
          kind: "text",
          required: false,
          defaultValue: "school.test",
          label: google.settings.name,
        },
      ],
    },
    create: () => {
      const provider = { ...google.create(credentials, runtime) };
      Reflect.deleteProperty(provider, "supportsRule");
      return provider;
    },
  };
  const f = fixture([entry]);
  expect(f.settings.status()).toMatchObject({
    providers: [{ guides: [], kinds: [{ ready: true }, { ready: true }] }],
  });
  f.settings.save(f.store.read(), 0, { [id]: {} });
  expect(f.store.read().identityConnections?.[id]).toEqual({ domain: "school.test" });
  expect(f.settings.read(f.store.read()).providers[0]?.values).toStrictEqual({
    domain: "school.test",
  });
  const off = new IdentitySettings(f.store, { ...f.options, active: {} });
  expect(off.status()).toMatchObject({
    providers: [{ kinds: [{ ready: false }, { ready: false }] }],
  });
});
it("authorizes credential edits only for administrators but exposes nonsecret readiness to class teachers", () => {
  const f = fixture();
  const visitor = { ...teacher, userId: "user:other" };
  expect(f.endpoint.execute(visitor, encode({ operation: "identity-status" }))).toEqual(
    f.settings.status(),
  );
  for (const body of [
    { operation: "identity-read" },
    { operation: "identity-save", expectedRevision: 0, connections: {} },
  ])
    expect(() => f.endpoint.execute(visitor, encode(body))).toThrow(status(403));
  expect(() =>
    f.endpoint.execute({ ...teacher, role: "student" }, encode({ operation: "identity-status" })),
  ).toThrow(status(403));
  expect(f.endpoint.execute(teacher, encode({ operation: "identity-read" }))).toEqual(
    f.settings.read(f.store.read()),
  );
  expect(
    f.endpoint.execute(
      teacher,
      encode({
        operation: "identity-save",
        expectedRevision: 0,
        connections: { [id]: credentials },
      }),
    ),
  ).toMatchObject({ revision: 1, restart: false });
});
it("handles absent host support and uninitialized or removed identity plugins without touching credentials", () => {
  const f = fixture([]);
  expect(f.settings.read(f.store.read()).providers).toEqual([]);
  expect(f.settings.status()).toEqual({ providers: [] });
  const none = new ServerSettingsService(f.store, []);
  expect(none.execute(teacher, encode({ operation: "identity-status" }))).toEqual({
    providers: [],
  });
  expect(() => none.execute(teacher, encode({ operation: "identity-read" }))).toThrow(status(404));
  const uninitialized = new ServerSettingsService(
    { ...f.store, read: () => null },
    [],
    undefined,
    [],
    f.options,
  );
  expect(() => uninitialized.execute(teacher, encode({ operation: "identity-read" }))).toThrow(
    status(403),
  );
});
it("clears optional group secrets explicitly, retains removed-plugin settings and validates URL fields", () => {
  const grouped = {
    ...credentials,
    serviceAccountEmail: "service@school.test",
    serviceAccountKey: "-----BEGIN PRIVATE KEY-----\nsynthetic",
    adminEmail: "admin@school.test",
  };
  const f = fixture([google], {
    identityConnections: { [id]: grouped, "org.example.removed": { secret: "keep-private" } },
  });
  f.settings.save(f.store.read(), 0, {
    [id]: { ...credentials, serviceAccountEmail: "", serviceAccountKey: "", adminEmail: "" },
  });
  expect(f.store.read().identityConnections).toEqual({
    [id]: credentials,
    "org.example.removed": { secret: "keep-private" },
  });
  const ready = new IdentitySettings(f.store, { ...f.options, active: { [id]: grouped } });
  expect(ready.status()).toMatchObject({
    providers: [{ kinds: [{ ready: true }, { ready: true }] }],
  });
  const entry: IdentityProviderCatalogEntry = {
    ...google,
    settings: {
      ...google.settings,
      fields: [
        ...google.settings.fields,
        { key: "endpoint", label: google.settings.name, kind: "url", required: false },
      ],
    },
    create: () => google.create(credentials, runtime),
  };
  const urls = fixture([entry]);
  expect(() =>
    urls.settings.save(urls.store.read(), 0, { [id]: { ...credentials, endpoint: "invalid" } }),
  ).toThrow(status(400));
  urls.settings.save(urls.store.read(), 0, {
    [id]: { ...credentials, endpoint: "https://identity.test" },
  });
  expect(urls.store.read().identityConnections?.[id]?.endpoint).toBe("https://identity.test");
});

it("validates declared requirements even when a plugin factory is permissive, including fresh secrets", () => {
  const entry: IdentityProviderCatalogEntry = {
    ...google,
    settings: {
      version: 1,
      name: google.settings.name,
      fields: [
        { key: "tenant", kind: "text", required: true, label: google.settings.name },
        { key: "token", kind: "secret", required: true, label: google.settings.name },
        { key: "note", kind: "text", required: false, label: google.settings.name },
      ],
    },
    create: () => google.create(credentials, runtime),
  };
  const f = fixture([entry], { identityConnections: {} });
  for (const values of [{ tenant: "school" }, { token: "new-secret" }])
    expect(() => f.settings.save(f.store.read(), 0, { [id]: values })).toThrow(status(400));
  expect(f.store.write).not.toHaveBeenCalled();
  const state = {
    ...f.store.read(),
    identityConnections: { [id]: { tenant: "school", token: "private", note: "" } },
  };
  expect(f.settings.read(state).providers[0]?.values).toEqual({ tenant: "school", note: "" });
});
it("removes disabled installed connections while retaining absent plugins among multiple installed entries", () => {
  const other = { ...google, manifest: { ...google.manifest, id: "org.example.other" } };
  const f = fixture([google, other], {
    identityConnections: { [id]: credentials, "org.example.removed": { token: "keep" } },
  });
  f.settings.save(f.store.read(), 0, {});
  expect(f.store.read().identityConnections).toEqual({ "org.example.removed": { token: "keep" } });
});
