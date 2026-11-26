import { expect, it, vi } from "vitest";
import { inferenceProviderCatalog } from "@marea/plugin-runtime";
import { student } from "../../../test-support/teaching-integration.fixture.js";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import type { ServerSettings } from "../../server-settings/contracts.js";
import type { RunSnapshotCapture } from "../../sessions/contracts.js";
import type { TeachingConfigurationRepository } from "../../teaching/configuration/contracts.js";
import { StoredTeachingConfigurationSchema } from "../../teaching/configuration/configuration-schema.js";
import { notesModels, sessionSnapshots } from "./notes-models.js";

const found = inferenceProviderCatalog[0];
if (found === undefined) throw new Error("missing provider fixture");
const provider = found;
const common = { providerId: provider.manifest.id, model: "synthetic/common" };
const configuration = StoredTeachingConfigurationSchema.parse(teachingConfiguration());

function fixture(overrides: Partial<ServerSettings> = {}) {
  const state: ServerSettings = {
    version: 1,
    revision: 0,
    administrators: ["owner"],
    connections: { [provider.manifest.id]: { apiKey: "synthetic-key" } },
    route: null,
    education: {},
    legacyRoutes: [],
    useCommonRoute: false,
    ...overrides,
  };
  const listModels = vi.fn().mockResolvedValue([
    { id: "synthetic/common", name: "Common", pricing: null, contextWindowTokens: 131_072 },
    { id: "synthetic/unknown", name: "Unknown", pricing: null },
  ]);
  const settings = {
    store: { read: () => state, write: vi.fn() },
    catalog: [{ ...provider, listModels }],
  };
  const loadForTeacher = vi.fn<TeachingConfigurationRepository["loadForTeacher"]>(
    () => configuration,
  );
  const configurations: TeachingConfigurationRepository = {
    requireTeacherClass: vi.fn(),
    loadForTeacher,
    loadForStudent: vi.fn(() => configuration),
    saveRevision: vi.fn(() => configuration),
  };
  return { settings, listModels, configurations, loadForTeacher, state };
}

it("uses the class route, or the server's common route when it replaces class routes", () => {
  const f = fixture();
  expect(notesModels(f.configurations, f.settings).classRoute("t1", "class:one")).toBe(
    configuration.providerRoute,
  );
  expect(f.loadForTeacher).toHaveBeenCalledWith("t1", "class:one");
  expect(notesModels(f.configurations, undefined).classRoute("t1", "class:one")).toBe(
    configuration.providerRoute,
  );
  const shared = fixture({ route: common });
  expect(notesModels(shared.configurations, shared.settings).classRoute("t1", "class:one")).toBe(
    common,
  );
});

it("reads the model's context window from the provider catalog with the saved connection", async () => {
  const f = fixture();
  const models = notesModels(f.configurations, f.settings);
  const signal = new AbortController().signal;
  await expect(
    models.contextWindow(provider.manifest.id, "synthetic/common", signal),
  ).resolves.toBe(131_072);
  expect(f.listModels).toHaveBeenCalledWith(
    { apiKey: "synthetic-key", settings: { apiKey: "synthetic-key" } },
    signal,
  );
  await expect(
    models.contextWindow(provider.manifest.id, "synthetic/unknown", signal),
  ).resolves.toBeUndefined();
  f.state.connections[provider.manifest.id] = { endpoint: "https://models.invalid/v1" };
  await models.contextWindow(provider.manifest.id, "synthetic/common", signal);
  expect(f.listModels).toHaveBeenLastCalledWith(
    {
      apiKey: "",
      endpoint: "https://models.invalid/v1",
      settings: { endpoint: "https://models.invalid/v1" },
    },
    signal,
  );
  await expect(models.contextWindow("missing", "m", signal)).resolves.toBeUndefined();
  const unlisted = { manifest: provider.manifest, create: provider.create };
  await expect(
    notesModels(f.configurations, { ...f.settings, catalog: [unlisted] }).contextWindow(
      provider.manifest.id,
      "synthetic/common",
      signal,
    ),
  ).resolves.toBeUndefined();
  await expect(
    notesModels(f.configurations, undefined).contextWindow(provider.manifest.id, "m", signal),
  ).resolves.toBeUndefined();
  f.listModels.mockResolvedValueOnce([{ id: "" }]);
  await expect(models.contextWindow(provider.manifest.id, "m", signal)).rejects.toThrow();
});

it("adapts new sessions through the insights and prepares them with the session route", async () => {
  const f = fixture({ route: common, useCommonRoute: true });
  const capture = vi.fn((captured: RunSnapshotCapture) => captured);
  const prepare = vi.fn(() => Promise.resolve());
  const source = sessionSnapshots(f.configurations, f.settings, { capture, prepare });
  expect(source.capture("snapshot:new", student).providerRoute).toBe(common);
  await source.prepare(student);
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ providerRoute: common }), student);
  const plain = sessionSnapshots(f.configurations, undefined, undefined);
  expect(plain.capture("snapshot:new", student).providerRoute).toBe(configuration.providerRoute);
  await plain.prepare(student);
  expect(capture).toHaveBeenCalledOnce();
});

it("answers undefined for every unknown part instead of failing", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.loadForTeacher.mockReturnValueOnce(null);
  expect(notesModels(f.configurations, f.settings).classRoute("t1", "class:one")).toBeUndefined();
  const other = vi.fn().mockResolvedValue([]);
  const catalog = [
    { ...provider, manifest: { ...provider.manifest, id: "other" }, listModels: other },
  ];
  const models = notesModels(f.configurations, {
    ...f.settings,
    catalog: [...catalog, ...f.settings.catalog],
  });
  await expect(
    models.contextWindow(provider.manifest.id, "synthetic/common", signal),
  ).resolves.toBe(131_072);
  expect(other).not.toHaveBeenCalled();
  await expect(
    models.contextWindow(provider.manifest.id, "absent", signal),
  ).resolves.toBeUndefined();
  f.state.connections.missing = { apiKey: "k" };
  await expect(models.contextWindow("missing", "m", signal)).resolves.toBeUndefined();
  await expect(models.contextWindow("other", "m", signal)).resolves.toBeUndefined();
  expect(other).not.toHaveBeenCalled();
  const empty = notesModels(f.configurations, {
    ...f.settings,
    store: { read: () => null, write: vi.fn() },
  });
  await expect(empty.contextWindow(provider.manifest.id, "m", signal)).resolves.toBeUndefined();
  expect(empty.classRoute("t1", "class:one")).toBe(configuration.providerRoute);
});
