import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createIdentityProviderManifestSchema,
  type IdentityProvider,
  type IdentityProviderCatalogEntry,
  type ProviderSettingsDescriptor,
} from "@marea/plugin-api";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureIdentityProviders,
  identityConnectionValues,
  providerSettingsValues,
  readIdentityProviderSettings,
  systemIdentityRuntime,
} from "./identity-provider-composition.js";

const label = { es: "Centro", en: "School", eu: "Ikastetxea" };
const settings: ProviderSettingsDescriptor = {
  version: 1,
  name: label,
  fields: [
    { key: "clientId", kind: "text", required: true, label },
    { key: "clientSecret", kind: "secret", required: true, label },
    {
      key: "endpoint",
      kind: "url",
      required: false,
      defaultValue: "https://idp.test/token",
      label,
    },
    { key: "hint", kind: "text", required: false, label },
    { key: "audit", kind: "url", required: false, label },
  ],
};
const provider: IdentityProvider = {
  authorizationUrl: () => "https://idp.test",
  complete: () => Promise.reject(new Error("unused")),
  admits: () => Promise.resolve(false),
  normalizeRule: () => undefined,
};

function entry(created: unknown[]): IdentityProviderCatalogEntry {
  return {
    manifest: createIdentityProviderManifestSchema().parse({
      id: "org.example.idp",
      displayNameKey: "plugins.idp.name",
      descriptionKey: "plugins.idp.description",
      implementationVersion: "1.0.0",
      entrypoint: "./src/index.ts",
      configurationVersion: 1,
      kind: "identity-provider",
      apiVersion: "1.0",
      capabilities: ["authorization-code"],
      runtimeTargets: ["teacher-server"],
      dataClassifications: ["student-identifier"],
    }),
    descriptor: { displayName: label, ruleKinds: [{ kind: "email", label }] },
    settings,
    create: (values, runtime) => {
      created.push([values, runtime]);
      return provider;
    },
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("identity provider composition", () => {
  it("resolves exactly the declared settings with defaults", () => {
    expect(providerSettingsValues(settings, { clientId: "id", clientSecret: "secret" })).toEqual({
      clientId: "id",
      clientSecret: "secret",
      endpoint: "https://idp.test/token",
    });
    expect(
      providerSettingsValues(settings, {
        clientId: "id",
        clientSecret: "secret",
        endpoint: "https://other.test",
        hint: "",
        audit: "https://audit.test",
      }),
    ).toEqual({
      clientId: "id",
      clientSecret: "secret",
      endpoint: "https://other.test",
      audit: "https://audit.test",
    });
  });

  it.each([
    [{ clientId: "id" }, "The identity provider settings miss a required field."],
    [{ clientId: "id", clientSecret: "" }, "The identity provider settings miss a required field."],
    [
      { clientId: "id", clientSecret: "s", other: "x" },
      "The identity provider settings contain an undeclared field.",
    ],
    [
      { clientId: "id", clientSecret: "s", endpoint: "not a url" },
      "The identity provider settings contain an invalid address.",
    ],
  ])("rejects settings %j", (values, message) => {
    expect(() => providerSettingsValues(settings, values)).toThrow(message);
  });

  it("rejects non-string or oversized values", () => {
    expect(() => providerSettingsValues(settings, { clientId: 1, clientSecret: "s" })).toThrow();
    expect(() =>
      providerSettingsValues(settings, { clientId: "x".repeat(16_385), clientSecret: "s" }),
    ).toThrow();
    expect(
      providerSettingsValues(settings, { clientId: "x".repeat(16_384), clientSecret: "s" })
        .clientId,
    ).toHaveLength(16_384);
  });

  it("configures installed providers and skips removed plugins", () => {
    const created: unknown[] = [];
    const runtime = { fetch: () => Promise.reject(new Error("offline")), now: () => 0 };
    const read: string[] = [];
    const configured = configureIdentityProviders(
      [entry(created)],
      [
        { pluginId: "org.example.removed", settingsPath: "/removed.json" },
        { pluginId: "org.example.idp", settingsPath: "/idp.json" },
      ],
      (path) => {
        read.push(path);
        return { clientId: "id", clientSecret: "secret" };
      },
      runtime,
    );
    expect(configured).toEqual([
      {
        id: "org.example.idp",
        descriptor: { displayName: label, ruleKinds: [{ kind: "email", label }] },
        provider,
      },
    ]);
    expect(read).toEqual(["/idp.json"]);
    expect(created).toEqual([
      [{ clientId: "id", clientSecret: "secret", endpoint: "https://idp.test/token" }, runtime],
    ]);
    expect(configureIdentityProviders([entry([])], undefined, () => ({}), runtime)).toEqual([]);
    expect(() =>
      configureIdentityProviders(
        [{ ...entry([]), descriptor: { displayName: label, ruleKinds: [] } }],
        [{ pluginId: "org.example.idp", settingsPath: "/idp.json" }],
        () => ({ clientId: "id", clientSecret: "secret" }),
        runtime,
      ),
    ).toThrow();
  });

  it("reads bounded UTF-8 JSON settings files", () => {
    const directory = mkdtempSync(join(tmpdir(), "marea-identity-settings-"));
    directories.push(directory);
    const path = join(directory, "settings.json");
    writeFileSync(path, JSON.stringify({ clientId: "id" }), { mode: 0o600 });
    expect(readIdentityProviderSettings(path)).toEqual({ clientId: "id" });
    writeFileSync(path, new Uint8Array([0x22, 0xff, 0x22]), { mode: 0o600 });
    expect(() => readIdentityProviderSettings(path)).toThrow();
    writeFileSync(path, `"${"x".repeat(65_536)}"`, { mode: 0o600 });
    expect(() => readIdentityProviderSettings(path)).toThrow();
  });

  it("gives plugins the host clock and network", async () => {
    const before = Date.now();
    expect(systemIdentityRuntime.now()).toBeGreaterThanOrEqual(before);
    const response = await systemIdentityRuntime.fetch(new Request("data:text/plain,ok"));
    expect(await response.text()).toBe("ok");
  });
});

it("imports only installed identity settings and leaves removed plugin paths unread", () => {
  expect(identityConnectionValues([], undefined)).toEqual({});
  expect(
    identityConnectionValues(
      [entry([])],
      [{ pluginId: "org.example.gone", settingsPath: "/must-not-read" }],
    ),
  ).toEqual({});
  const root = mkdtempSync(join(tmpdir(), "marea-identity-import-"));
  directories.push(root);
  const file = join(root, "settings.json");
  writeFileSync(file, JSON.stringify({ clientId: "public", clientSecret: "synthetic-secret" }));
  expect(
    identityConnectionValues([entry([])], [{ pluginId: "org.example.idp", settingsPath: file }]),
  ).toEqual({
    "org.example.idp": {
      clientId: "public",
      clientSecret: "synthetic-secret",
      endpoint: "https://idp.test/token",
    },
  });
});
