import { describe, expect, it } from "vitest";

import {
  IdentityProviderDescriptorSchema,
  IdentityProviderError,
  createIdentityProviderManifestSchema,
  defineIdentityProviderCatalogEntry,
  parseIdentityProviderEntry,
  type IdentityProviderCatalogEntry,
} from "./identity-provider.js";

const label = { es: "Correo", en: "Email", eu: "Posta" } as const;
const manifest = {
  id: "org.example.idp",
  displayNameKey: "plugins.example.name",
  descriptionKey: "plugins.example.description",
  implementationVersion: "1.0.0",
  entrypoint: "./src/index.ts",
  configurationVersion: 1,
  kind: "identity-provider",
  apiVersion: "1.0",
  capabilities: ["authorization-code", "group-admission"],
  runtimeTargets: ["teacher-server"],
  dataClassifications: ["student-identifier"],
} as const;
const descriptor = {
  displayName: { es: "Centro", en: "School", eu: "Ikastetxea" },
  ruleKinds: [{ kind: "email", label }],
};
const settings = {
  version: 1 as const,
  name: { es: "Centro", en: "School", eu: "Ikastetxea" },
  fields: [
    {
      key: "clientId",
      kind: "text" as const,
      required: true,
      label: { es: "Cliente", en: "Client", eu: "Bezeroa" },
    },
  ],
};

describe("identity provider plugins", () => {
  it("accepts a server-only manifest with explicit student identifier handling", () => {
    expect(createIdentityProviderManifestSchema().parse(manifest)).toMatchObject({
      kind: "identity-provider",
      requiredDependencies: [],
    });
  });

  it.each([
    ["no capability", { capabilities: [] }],
    ["a duplicate capability", { capabilities: ["authorization-code", "authorization-code"] }],
    ["an unknown capability", { capabilities: ["password"] }],
    ["a browser target", { runtimeTargets: ["dashboard-browser"] }],
    ["no data classification", { dataClassifications: [] }],
    [
      "a duplicate classification",
      { dataClassifications: ["student-identifier", "student-identifier"] },
    ],
    ["student content", { dataClassifications: ["student-content"] }],
    ["another API", { apiVersion: "2.0" }],
    ["an extra field", { secret: "x" }],
    ["a self dependency", { requiredDependencies: ["org.example.idp"] }],
  ])("rejects %s", (_, change) => {
    expect(
      createIdentityProviderManifestSchema().safeParse({ ...manifest, ...change }).success,
    ).toBe(false);
  });

  it("explains duplicate capabilities, classifications and relationships", () => {
    const messages = (change: object) =>
      createIdentityProviderManifestSchema()
        .safeParse({ ...manifest, ...change })
        .error?.issues.map((issue) => issue.message);
    expect(messages({ capabilities: ["group-admission", "group-admission"] })).toEqual([
      "Capabilities must be unique.",
    ]);
    expect(messages({ dataClassifications: ["student-identifier", "student-identifier"] })).toEqual(
      ["Data classifications must be unique."],
    );
    expect(messages({ conflicts: ["org.example.idp"] })).toEqual([
      "Dependency and conflict IDs must not overlap or refer to the plugin itself.",
    ]);
  });

  it("describes providers with bounded labels and unique rule kinds", () => {
    expect(IdentityProviderDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    const kinds = Array.from({ length: 8 }, (_, index) => ({
      kind: `k${String(index)}`,
      label: { ...label, es: "x".repeat(120) },
    }));
    expect(
      IdentityProviderDescriptorSchema.parse({ ...descriptor, ruleKinds: kinds }).ruleKinds,
    ).toHaveLength(8);
    expect(
      IdentityProviderDescriptorSchema.parse({
        ...descriptor,
        ruleKinds: [{ kind: `a${"b".repeat(31)}`, label }],
      }).ruleKinds,
    ).toHaveLength(1);
    for (const invalid of [
      { ...descriptor, ruleKinds: [] },
      { ...descriptor, ruleKinds: [...kinds, { kind: "k8", label }] },
      { ...descriptor, ruleKinds: [{ kind: "Email", label }] },
      { ...descriptor, ruleKinds: [{ kind: "1email", label }] },
      { ...descriptor, ruleKinds: [{ kind: "e_mail", label }] },
      { ...descriptor, ruleKinds: [{ kind: " email", label }] },
      { ...descriptor, ruleKinds: [{ kind: "email ", label }] },
      { ...descriptor, ruleKinds: [{ kind: `a${"b".repeat(32)}`, label }] },
      { ...descriptor, ruleKinds: [{ kind: "email", label: { ...label, en: "" } }] },
      { ...descriptor, ruleKinds: [{ kind: "email", label: { ...label, eu: "x".repeat(121) } }] },
      { ...descriptor, displayName: { es: "Centro", en: "School" } },
      { ...descriptor, settings: {} },
    ])
      expect(IdentityProviderDescriptorSchema.safeParse(invalid).success).toBe(false);
    expect(
      IdentityProviderDescriptorSchema.safeParse({
        ...descriptor,
        ruleKinds: [
          { kind: "email", label },
          { kind: "email", label },
        ],
      }).error?.issues[0]?.message,
    ).toBe("Admission rule kinds must be unique.");
  });

  it("parses plugin-authored entry parts and carries typed provider failures", () => {
    const entry: IdentityProviderCatalogEntry = defineIdentityProviderCatalogEntry({
      manifest: createIdentityProviderManifestSchema().parse(manifest),
      descriptor,
      settings,
      create: () => {
        throw new Error("not used");
      },
    });
    expect(parseIdentityProviderEntry(entry)).toEqual(entry);
    expect(() =>
      parseIdentityProviderEntry({ ...entry, settings: { ...settings, version: 2 as 1 } }),
    ).toThrow();
    expect(() =>
      parseIdentityProviderEntry({ ...entry, descriptor: { ...descriptor, ruleKinds: [] } }),
    ).toThrow();
    const error = new IdentityProviderError("denied", "Not allowed.");
    expect(error).toMatchObject({ name: "IdentityProviderError", code: "denied" });
    expect(error.message).toBe("Not allowed.");
    expect(error).toBeInstanceOf(Error);
  });
});
