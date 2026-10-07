import { afterEach, expect, it, vi } from "vitest";
import { inferenceProviderCatalog } from "@marea/plugin-runtime";
import { onboardingSettings, emptySetupSettings } from "./onboarding-settings.boundary.js";
import { present, setupInput } from "./onboarding.fixture.js";
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
it("starts with one administrator and publishes descriptors without secrets", async () => {
  expect(emptySetupSettings()).toEqual({
    version: 1,
    revision: 0,
    administrators: ["user:teacher"],
    connections: {},
    route: null,
    legacyRoutes: [],
    education: {},
    useCommonRoute: false,
  });
  expect((await onboardingSettings().read()).settings).toMatchObject({
    administrator: true,
    route: null,
    providers: [{ id: "org.marea.openrouter", supportsModels: true }],
  });
});
it("validates the provider key before a complete route can be installed", async () => {
  const listModels = vi.fn().mockResolvedValue([]);
  const catalog = [{ ...present(inferenceProviderCatalog[0]), listModels }];
  const service = onboardingSettings(catalog);
  const input = setupInput();
  expect(
    await service.models(
      {
        operation: "models",
        providerId: input.route.providerId,
        values: input.connections[input.route.providerId],
      },
      signal,
    ),
  ).toMatchObject({ models: [] });
  const validated = await service.validate(input, signal);
  expect(validated).toMatchObject({
    request: input,
    origin: "http://127.0.0.1:18793",
    settings: { revision: 1, route: input.route, useCommonRoute: true },
  });
  expect(listModels).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await service.read())).not.toContain("synthetic-api-key");
  listModels.mockRejectedValueOnce(new Error("invalid key"));
  await expect(service.validate(input, signal)).rejects.toThrow();
});
it("supports providers without catalogs and requires an HTTPS public origin", async () => {
  const base = present(inferenceProviderCatalog[0]);
  const entry = { manifest: base.manifest, settings: present(base.settings), create: base.create };
  const service = onboardingSettings([entry]);
  const result = await service.validate(
    setupInput({ access: "https", publicOrigin: "https://school.test/" }),
    signal,
  );
  expect(result.origin).toBe("https://school.test");
  for (const publicOrigin of ["http://127.0.0.1:1234", "invalid"])
    await expect(
      service.validate(setupInput({ access: "https", publicOrigin }), signal),
    ).rejects.toThrow();
  await expect(service.validate(setupInput({ connections: {} }), signal)).rejects.toThrow();
  await expect(
    service.models({ operation: "models", providerId: "missing", values: {} }, signal),
  ).rejects.toThrow();
  await expect(service.models({ operation: "models", unexpected: true }, signal)).rejects.toThrow();
});
it("requires an explicit usage budget and validates the bounded setup document", async () => {
  const service = onboardingSettings();
  const input = setupInput();
  await expect(
    service.validate(
      { ...input, route: { providerId: input.route.providerId, model: input.route.model } },
      signal,
    ),
  ).rejects.toThrow();
  for (const field of [
    { port: 1023 },
    { port: 65536 },
    { publicOrigin: "x".repeat(2049) },
    { google: { domain: "invalid", clientId: "x", clientSecret: "x" } },
    { google: { domain: "school.test", clientId: "", clientSecret: "x" } },
    { unexpected: true },
  ])
    await expect(service.validate({ ...input, ...field }, signal)).rejects.toThrow();
});
it("does not mistake another provider's catalog for the chosen provider", async () => {
  const base = present(inferenceProviderCatalog[0]);
  const listModels = vi.fn().mockResolvedValue([]);
  const { manifest, settings, create } = base;
  const plain = { manifest, settings: present(settings), create };
  const service = onboardingSettings([
    { ...base, manifest: { ...manifest, id: "different.provider" }, listModels },
    plain,
  ]);
  const result = await service.validate(setupInput(), signal);
  expect(result.settings.useCommonRoute).toBe(true);
  expect(listModels).not.toHaveBeenCalled();
  await expect(
    service.validate(
      setupInput({ access: "https", publicOrigin: "http://127.0.0.1:1234" }),
      signal,
    ),
  ).rejects.toThrow("invalid-origin");
});
it("saves a common route under the bootstrap teacher authority", async () => {
  const { ServerSettingsService } =
    await import("../../apps/teacher-server/src/server-settings/service.boundary.js");
  const execute = vi.spyOn(ServerSettingsService.prototype, "execute");
  const base = present(inferenceProviderCatalog[0]);
  const service = onboardingSettings([{ ...base, listModels: () => Promise.resolve([]) }]);
  await service.validate(setupInput(), signal);
  expect(execute.mock.calls[0]?.[0]).toEqual({
    role: "teacher",
    userId: "user:teacher",
    classId: null,
    displayName: "Teacher",
  });
  expect(JSON.parse(new TextDecoder().decode(execute.mock.calls[0]?.[1]))).toMatchObject({
    operation: "save",
    useCommonRoute: true,
  });
  execute.mockRestore();
});
it("checks the selected model catalog even when unrelated providers are installed", async () => {
  const base = present(inferenceProviderCatalog[0]);
  const listModels = vi.fn().mockResolvedValue([]);
  await onboardingSettings([
    { ...base, listModels },
    { ...base, manifest: { ...base.manifest, id: "unrelated.provider" } },
  ]).validate(setupInput(), signal);
  expect(listModels).toHaveBeenCalledOnce();
});

it("has no provider-specific setup when both catalogs are empty", async () => {
  const setup = onboardingSettings([], []);
  expect(await setup.read()).toMatchObject({ settings: { providers: [] }, identityProviders: [] });
  await expect(setup.validate(setupInput(), signal)).rejects.toThrow();
});
it("uses an installed identity plugin's descriptor, defaults and validation", async () => {
  const { identityProviderCatalog } = await import("@marea/plugin-runtime");
  const base = present(identityProviderCatalog[0]);
  const label = { es: "Synthetic identity", en: "Synthetic identity", eu: "Synthetic identity" };
  const create = vi.fn(() =>
    base.create(
      { domain: "school.test", clientId: "id", clientSecret: "secret" },
      { fetch, now: Date.now },
    ),
  );
  const identity = {
    ...base,
    manifest: { ...base.manifest, id: "org.example.login" },
    settings: {
      version: 1 as const,
      name: label,
      fields: [
        { key: "tenant", label, kind: "text" as const, required: true },
        { key: "secret", label, kind: "secret" as const, required: true },
        { key: "region", label, kind: "text" as const, required: false, defaultValue: "local" },
      ],
    },
    create,
  };
  const model = {
    ...present(inferenceProviderCatalog[0]),
    listModels: vi.fn(() => Promise.resolve([])),
  };
  const setup = onboardingSettings([model], [identity]);
  expect((await setup.read()).identityProviders).toEqual([
    { id: identity.manifest.id, descriptor: identity.settings },
  ]);
  const values = { tenant: "school", secret: "private-key" };
  const input = setupInput({ identityProviders: { [identity.manifest.id]: values } });
  await setup.validate(input, signal);
  expect(create).toHaveBeenCalledWith(
    { ...values, region: "local" },
    (
      await import("../../apps/teacher-server/src/platform/teacher-host/identity-provider-composition.js")
    ).systemIdentityRuntime,
  );
  expect(JSON.stringify(await setup.read())).not.toContain("private-key");
  await expect(onboardingSettings([model], []).validate(input, signal)).rejects.toThrow(
    "identity-provider-unavailable",
  );
  for (const invalid of [{ tenant: "school" }, { ...values, unknown: "value" }])
    await expect(
      setup.validate(
        setupInput({ identityProviders: { [identity.manifest.id]: invalid } }),
        signal,
      ),
    ).rejects.toThrow();
  await expect(
    setup.validate(setupInput({ identityProviders: { "org.example.absent": values } }), signal),
  ).rejects.toThrow("identity-provider-unavailable");
  create.mockImplementationOnce(() => {
    throw new Error("invalid provider settings");
  });
  await expect(setup.validate(input, signal)).rejects.toThrow("invalid provider settings");
});
